/**
 * Cold-start retry cadence for the signature updater.
 *
 * The defect: the updater had ONE schedule — `intervalMs`, floored at 15
 * minutes and defaulting to an hour. That floor is ClamAV's politeness request
 * about TOPPING UP a database you already have. A machine with no database at
 * all cannot scan anything, and one lost cold-start attempt (a timeout, a 429)
 * meant a full hour in which every resume ingestion arrived at a scanner with
 * nothing to screen with.
 *
 * A cold machine and a warm machine have opposite urgency and shared one
 * cadence. These tests pin the two apart.
 */

import { describe, it, expect, vi } from 'vitest';
import { startAvUpdater, nextUpdateDelayMs, AV_COLD_RETRY_MS, AV_UPDATER_BOUNDS } from '../lib/av-updater.js';

describe('nextUpdateDelayMs', () => {
  it('uses the steady-state interval whenever a database exists', () => {
    expect(nextUpdateDelayMs(false, 0, 3_600_000, () => 0.5)).toBe(3_600_000);
    expect(nextUpdateDelayMs(false, 9, 3_600_000, () => 0.5)).toBe(3_600_000);
  });

  it('climbs the cold ladder and caps at its last rung', () => {
    const noJitter = (): number => 1.0;
    expect(nextUpdateDelayMs(true, 0, 3_600_000, noJitter)).toBe(AV_COLD_RETRY_MS[0]);
    expect(nextUpdateDelayMs(true, 1, 3_600_000, noJitter)).toBe(AV_COLD_RETRY_MS[1]);
    expect(nextUpdateDelayMs(true, 2, 3_600_000, noJitter)).toBe(AV_COLD_RETRY_MS[2]);
    // Capped, not unbounded — and still far under the steady-state interval.
    expect(nextUpdateDelayMs(true, 50, 3_600_000, noJitter)).toBe(AV_COLD_RETRY_MS[2]);
    expect(nextUpdateDelayMs(true, 50, 3_600_000, noJitter)).toBeLessThan(AV_UPDATER_BOUNDS.intervalMs.min);
  });

  it('applies full jitter so a restarting fleet does not hit the mirror in lockstep', () => {
    expect(nextUpdateDelayMs(true, 0, 3_600_000, () => 0)).toBe(AV_COLD_RETRY_MS[0]! / 2);
    expect(nextUpdateDelayMs(true, 0, 3_600_000, () => 0.999)).toBeLessThanOrEqual(AV_COLD_RETRY_MS[0]!);
  });
});

describe('startAvUpdater — self-scheduling cadence', () => {
  /** A timer seam that records requested delays and fires on demand. */
  function timers() {
    const armed: Array<{ fn: () => void; ms: number }> = [];
    return {
      delays: (): number[] => armed.map((a) => a.ms),
      fireLast: (): void => { armed[armed.length - 1]?.fn(); },
      setTimer: (fn: () => void, ms: number) => { armed.push({ fn, ms }); return armed.length; },
      clearTimer: () => undefined,
    };
  }

  it('schedules the NEXT attempt on the cold ladder while no database exists', async () => {
    const t = timers();
    const run = vi.fn(async () => ({ ok: false as const, reason: 'update_timeout' as const }));
    const handle = startAvUpdater({
      intervalMs: 3_600_000, timeoutMs: 600_000, immediate: true,
      isCold: () => true, setTimer: t.setTimer, clearTimer: t.clearTimer, random: () => 1.0,
      runOnce: run,
    });

    // Let the immediate attempt settle and the follow-up timer be armed.
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(t.delays()).toEqual([AV_COLD_RETRY_MS[0]]);

    t.fireLast();
    for (let i = 0; i < 50; i++) await Promise.resolve();
    // A lost cold attempt costs one minute, not one hour.
    expect(t.delays()).toEqual([AV_COLD_RETRY_MS[0], AV_COLD_RETRY_MS[1]]);
    handle.stop();
  });

  it('switches to the steady-state interval the moment a database exists', async () => {
    const t = timers();
    let cold = true;
    const run = vi.fn(async () => ({ ok: true as const }));
    const handle = startAvUpdater({
      intervalMs: 3_600_000, timeoutMs: 600_000, immediate: true,
      isCold: () => cold, setTimer: t.setTimer, clearTimer: t.clearTimer, random: () => 1.0,
      runOnce: run,
    });

    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(t.delays()).toEqual([AV_COLD_RETRY_MS[0]]);

    cold = false;
    t.fireLast();
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(t.delays()).toEqual([AV_COLD_RETRY_MS[0], 3_600_000]);
    handle.stop();
  });

  it('treats an unreadable database directory as cold, not as warm', async () => {
    const t = timers();
    const handle = startAvUpdater({
      intervalMs: 3_600_000, timeoutMs: 600_000, immediate: false,
      isCold: () => { throw new Error('fs_exploded'); },
      setTimer: t.setTimer, clearTimer: t.clearTimer, random: () => 1.0,
      runOnce: async () => ({ ok: true as const }),
    });
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(t.delays()).toEqual([AV_COLD_RETRY_MS[0]]);
    handle.stop();
  });

  it('stays single-flight: no second attempt is armed until the first settles', async () => {
    const t = timers();
    let release: (() => void) | null = null;
    const run = vi.fn(() => new Promise<{ ok: true }>((resolve) => {
      release = () => resolve({ ok: true as const });
    }));
    const handle = startAvUpdater({
      intervalMs: 3_600_000, timeoutMs: 600_000, immediate: true,
      isCold: () => true, setTimer: t.setTimer, clearTimer: t.clearTimer, random: () => 1.0,
      runOnce: run,
    });

    for (let i = 0; i < 50; i++) await Promise.resolve();
    // Two concurrent freshclam processes writing one database directory is the
    // update race that could corrupt a scan. Nothing is armed while in flight.
    expect(t.delays()).toEqual([]);
    release!();
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(t.delays()).toEqual([AV_COLD_RETRY_MS[0]]);
    handle.stop();
  });

  it('stop() arms nothing further', async () => {
    const t = timers();
    const handle = startAvUpdater({
      intervalMs: 3_600_000, timeoutMs: 600_000, immediate: true,
      isCold: () => true, setTimer: t.setTimer, clearTimer: t.clearTimer, random: () => 1.0,
      runOnce: async () => ({ ok: true as const }),
    });
    for (let i = 0; i < 50; i++) await Promise.resolve();
    handle.stop();
    const before = t.delays().length;
    t.fireLast();
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(t.delays().length).toBe(before);
  });
});
