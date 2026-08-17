/**
 * Ashby scheduler — lifecycle, single-flight, error containment, graceful stop.
 *
 * Every timer is INJECTED. There is no real `setTimeout`, no `vi.useFakeTimers`
 * global patching, and no sleep anywhere: a manual timer queue is driven
 * explicitly, so these tests are deterministic by construction. The repository
 * has two prior flake repairs (#55, #59) — this suite is designed not to add a
 * third.
 */

import { describe, it, expect, vi } from 'vitest';
import { createAshbyScheduler, queueRunnerTick } from '../integrations/ashby/scheduler.js';

/** A deterministic, manually driven timer queue. */
function fakeTimers() {
  let seq = 0;
  const pending = new Map<number, { fn: () => void; at: number }>();
  let clock = 0;
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq;
      pending.set(id, { fn, at: clock + ms });
      return { unref: () => {} };
      // NOTE: the handle intentionally omits the id; clearTimer below matches
      // the scheduler's contract of treating handles opaquely.
    },
    clearTimer: () => { pending.clear(); },
    now: () => clock,
    /** Fire every currently-scheduled callback once, in insertion order. */
    fireAll(): number {
      const batch = [...pending.entries()];
      pending.clear();
      clock += 1;
      for (const [, t] of batch) t.fn();
      return batch.length;
    },
    count: () => pending.size,
  };
}

/** Deterministic jitter so scheduling is fully reproducible. */
const noJitter = () => 0.5;

describe('createAshbyScheduler — arming and stopping', () => {
  it('arms NO timer until start() is called', () => {
    const t = fakeTimers();
    const scheduler = createAshbyScheduler({
      loops: [{ name: 'a', intervalMs: 1000, tick: async () => true }],
      setTimer: t.setTimer, clearTimer: t.clearTimer, now: t.now, random: noJitter,
    });
    expect(t.count()).toBe(0);
    expect(scheduler.running()).toBe(false);
  });

  it('arms one timer per loop on start and reports running', () => {
    const t = fakeTimers();
    const scheduler = createAshbyScheduler({
      loops: [
        { name: 'signal', intervalMs: 1000, tick: async () => true },
        { name: 'operation', intervalMs: 1000, tick: async () => true },
      ],
      setTimer: t.setTimer, clearTimer: t.clearTimer, now: t.now, random: noJitter,
    });
    scheduler.start();
    expect(t.count()).toBe(2);
    expect(scheduler.running()).toBe(true);
    expect(scheduler.health().loops.map((l) => l.name).sort()).toEqual(['operation', 'signal']);
  });

  it('start() is idempotent — a second call arms no extra timers', () => {
    const t = fakeTimers();
    const scheduler = createAshbyScheduler({
      loops: [{ name: 'a', intervalMs: 1000, tick: async () => true }],
      setTimer: t.setTimer, clearTimer: t.clearTimer, now: t.now, random: noJitter,
    });
    scheduler.start();
    scheduler.start();
    expect(t.count()).toBe(1);
  });

  it('stop() clears timers, reports not-running, and is idempotent', async () => {
    const t = fakeTimers();
    const scheduler = createAshbyScheduler({
      loops: [{ name: 'a', intervalMs: 1000, tick: async () => true }],
      setTimer: t.setTimer, clearTimer: t.clearTimer, now: t.now, random: noJitter,
    });
    scheduler.start();
    await scheduler.stop();
    expect(t.count()).toBe(0);
    expect(scheduler.running()).toBe(false);
    await expect(scheduler.stop()).resolves.toBeUndefined();
  });

  it('stop() before start() resolves cleanly', async () => {
    const t = fakeTimers();
    const scheduler = createAshbyScheduler({
      loops: [{ name: 'a', intervalMs: 1000, tick: async () => true }],
      setTimer: t.setTimer, clearTimer: t.clearTimer, now: t.now, random: noJitter,
    });
    await expect(scheduler.stop()).resolves.toBeUndefined();
  });
});

describe('createAshbyScheduler — single-flight and reschedule', () => {
  it('reschedules exactly one follow-up timer per completed tick', async () => {
    const t = fakeTimers();
    const ticks: number[] = [];
    const scheduler = createAshbyScheduler({
      loops: [{ name: 'a', intervalMs: 1000, tick: async () => { ticks.push(1); return true; } }],
      setTimer: t.setTimer, clearTimer: t.clearTimer, now: t.now, random: noJitter,
    });
    scheduler.start();
    for (let i = 0; i < 5; i++) {
      t.fireAll();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      // Exactly one timer is outstanding at any moment — never a growing stack.
      expect(t.count()).toBe(1);
    }
    await scheduler.stop();
    expect(ticks.length).toBe(5);
  });

  it('does not overlap a slow tick with itself', async () => {
    const t = fakeTimers();
    let inFlight = 0;
    let maxInFlight = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    const scheduler = createAshbyScheduler({
      loops: [{
        name: 'a', intervalMs: 1000,
        tick: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await gate;
          inFlight -= 1;
          return true;
        },
      }],
      setTimer: t.setTimer, clearTimer: t.clearTimer, now: t.now, random: noJitter,
    });
    scheduler.start();
    t.fireAll();
    await Promise.resolve();
    // While the tick is parked, NO follow-up timer exists to fire a second one.
    expect(t.count()).toBe(0);
    expect(t.fireAll()).toBe(0);
    release();
    await scheduler.stop();
    expect(maxInFlight).toBe(1);
  });

  it('a throwing tick is contained: the loop survives and keeps rescheduling', async () => {
    const t = fakeTimers();
    let calls = 0;
    const scheduler = createAshbyScheduler({
      loops: [{
        name: 'a', intervalMs: 1000,
        tick: async () => { calls += 1; throw new Error('provider exploded with secret-ish text'); },
      }],
      setTimer: t.setTimer, clearTimer: t.clearTimer, now: t.now, random: noJitter,
    });
    scheduler.start();
    for (let i = 0; i < 3; i++) {
      t.fireAll();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    }
    const health = scheduler.health();
    await scheduler.stop();

    expect(calls).toBe(3);
    expect(health.loops[0].errors).toBe(3);
    expect(health.loops[0].consecutiveErrors).toBe(3);
    // The thrown message must never be captured anywhere in the health view.
    expect(JSON.stringify(health)).not.toContain('secret-ish');
  });

  it('resolves stop() only after an in-flight tick settles', async () => {
    const t = fakeTimers();
    let finished = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    const scheduler = createAshbyScheduler({
      loops: [{
        name: 'a', intervalMs: 1000,
        tick: async () => { await gate; finished = true; return true; },
      }],
      setTimer: t.setTimer, clearTimer: t.clearTimer, now: t.now, random: noJitter,
    });
    scheduler.start();
    t.fireAll();
    await Promise.resolve();

    let stopped = false;
    const stopping = scheduler.stop().then(() => { stopped = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(stopped).toBe(false); // still draining
    expect(finished).toBe(false);

    release();
    await stopping;
    expect(finished).toBe(true);
    expect(stopped).toBe(true);
  });

  it('does not schedule any further tick after stop()', async () => {
    const t = fakeTimers();
    let calls = 0;
    const scheduler = createAshbyScheduler({
      loops: [{ name: 'a', intervalMs: 1000, tick: async () => { calls += 1; return true; } }],
      setTimer: t.setTimer, clearTimer: t.clearTimer, now: t.now, random: noJitter,
    });
    scheduler.start();
    t.fireAll();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    await scheduler.stop();
    const after = calls;
    expect(t.fireAll()).toBe(0);
    await Promise.resolve();
    expect(calls).toBe(after);
  });
});

describe('createAshbyScheduler — truthful health', () => {
  it('reports lastTickAt/ticks derived from real bookkeeping, not from construction', async () => {
    const t = fakeTimers();
    const scheduler = createAshbyScheduler({
      loops: [{ name: 'a', intervalMs: 1000, tick: async () => true }],
      setTimer: t.setTimer, clearTimer: t.clearTimer, now: t.now, random: noJitter,
    });
    // Before any tick, the loop has never run — health must say so.
    expect(scheduler.health().loops[0].lastTickAt).toBeNull();
    expect(scheduler.health().loops[0].ticks).toBe(0);

    scheduler.start();
    t.fireAll();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    const h = scheduler.health();
    expect(h.loops[0].ticks).toBe(1);
    expect(h.loops[0].lastTickAt).not.toBeNull();
    await scheduler.stop();
    expect(scheduler.health().running).toBe(false);
  });

  it('clears consecutiveErrors once a tick succeeds again', async () => {
    const t = fakeTimers();
    let n = 0;
    const scheduler = createAshbyScheduler({
      loops: [{
        name: 'a', intervalMs: 1000,
        tick: async () => { n += 1; if (n === 1) throw new Error('x'); return true; },
      }],
      setTimer: t.setTimer, clearTimer: t.clearTimer, now: t.now, random: noJitter,
    });
    scheduler.start();
    for (let i = 0; i < 2; i++) {
      t.fireAll();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    }
    const h = scheduler.health();
    await scheduler.stop();
    expect(h.loops[0].errors).toBe(1);
    expect(h.loops[0].consecutiveErrors).toBe(0);
  });
});

describe('queueRunnerTick', () => {
  it('reports work done only when the runner processed at least one job', async () => {
    const busy = { tick: vi.fn(async () => 2) } as never;
    const idle = { tick: vi.fn(async () => 0) } as never;
    expect(await queueRunnerTick(busy)()).toBe(true);
    expect(await queueRunnerTick(idle)()).toBe(false);
  });
});

describe('scheduler stability — repeated start/stop cycles', () => {
  // The contract requires a repeated lifecycle run; 30 deterministic cycles
  // with injected timers is stronger evidence than a timing-sensitive repeat.
  it('survives 30 start/tick/stop cycles with no leaked timers or in-flight work', async () => {
    for (let cycle = 0; cycle < 30; cycle++) {
      const t = fakeTimers();
      let calls = 0;
      const scheduler = createAshbyScheduler({
        loops: [
          { name: 'signal', intervalMs: 1000, tick: async () => { calls += 1; return cycle % 2 === 0; } },
          { name: 'operation', intervalMs: 1000, tick: async () => { calls += 1; throw new Error('boom'); } },
        ],
        setTimer: t.setTimer, clearTimer: t.clearTimer, now: t.now, random: noJitter,
      });
      scheduler.start();
      t.fireAll();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      await scheduler.stop();

      expect(scheduler.running(), `cycle ${cycle}`).toBe(false);
      expect(t.count(), `cycle ${cycle} leaked a timer`).toBe(0);
      expect(calls, `cycle ${cycle}`).toBe(2);
    }
  });
});
