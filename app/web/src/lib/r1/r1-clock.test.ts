import { describe, expect, it } from 'vitest';
import { anchorClock, clockSecondsLeft, retimeClock, roleplayClockText } from './r1-clock';

describe('the clock value', () => {
  it('counts down from the moment the number arrived, while running', () => {
    const clock = anchorClock(480, 1_000);
    expect(clockSecondsLeft(clock, true, 1_000)).toBe(480);
    expect(clockSecondsLeft(clock, true, 31_000)).toBe(450);
    expect(clockSecondsLeft(clock, true, 1_000 + 480_000)).toBe(0);
  });

  it('never goes below zero or above what it was told', () => {
    const clock = anchorClock(10, 5_000);
    expect(clockSecondsLeft(clock, true, 5_000 + 99_000)).toBe(0);
    // A reading taken "before" the anchor (clock skew in a test, a re-anchor race) does not add time.
    expect(clockSecondsLeft(clock, true, 1_000)).toBe(10);
  });

  it('holds still when not running, however long it has been', () => {
    const clock = anchorClock(480, 0);
    expect(clockSecondsLeft(clock, false, 600_000)).toBe(480);
  });
});

describe('the clock across phase changes', () => {
  const CLOCK = anchorClock(480, 0);

  it('freezes at the counted-down value when the role-play stops', () => {
    for (const to of ['aside', 'paused_disconnected', 'roleplay_exit', 'wrapup'] as const) {
      const frozen = retimeClock(CLOCK, 'roleplay', to, 90_000);
      expect(frozen, to).toEqual({ seconds: 390, at: 90_000 });
      // And it stays at 390 however long the pause lasts.
      expect(clockSecondsLeft(frozen!, false, 900_000), to).toBe(390);
    }
  });

  it('restarts from the held value when the role-play starts again, ignoring the pause', () => {
    const frozen = retimeClock(CLOCK, 'roleplay', 'aside', 90_000)!;
    const resumed = retimeClock(frozen, 'aside', 'roleplay', 400_000)!;
    expect(resumed).toEqual({ seconds: 390, at: 400_000 });
    expect(clockSecondsLeft(resumed, true, 430_000)).toBe(360);
  });

  it('starts counting at the first role-play phase it sees (a rejoin, an unseen phase)', () => {
    expect(retimeClock(anchorClock(300, 0), null, 'roleplay', 50_000)).toEqual({
      seconds: 300,
      at: 50_000,
    });
    expect(retimeClock(anchorClock(840, 0), 'transition', 'roleplay', 20_000)).toEqual({
      seconds: 840,
      at: 20_000,
    });
  });

  it('leaves the clock alone when the phase changes between two non-role-play phases', () => {
    expect(retimeClock(CLOCK, 'transition', 'aside', 9_999)).toBe(CLOCK);
    expect(retimeClock(CLOCK, 'aside', 'paused_disconnected', 9_999)).toBe(CLOCK);
    expect(retimeClock(CLOCK, 'roleplay', 'roleplay', 9_999)).toBe(CLOCK);
  });

  it('has nothing to retime without a clock', () => {
    expect(retimeClock(null, 'roleplay', 'aside', 1)).toBeNull();
    expect(retimeClock(null, 'aside', 'roleplay', 1)).toBeNull();
  });
});

describe('what the timer says', () => {
  it.each([
    [840, 'Role-play · 14 min left'],
    [481, 'Role-play · 9 min left'],
    [480, 'Role-play · 8 min left'],
    [479.2, 'Role-play · 8 min left'],
    [121, 'Role-play · 3 min left'],
    [120, 'Role-play · 2 min left'],
    [61, 'Role-play · 2 min left'],
    [60, 'Role-play · 1 min left'],
    [59.9, 'Role-play · under a minute left'],
    [1, 'Role-play · under a minute left'],
    [0.2, 'Role-play · under a minute left'],
    [0, 'Role-play · wrapping up'],
    [-5, 'Role-play · wrapping up'],
    [Number.NaN, 'Role-play · wrapping up'],
  ])('%d seconds reads %s', (seconds, text) => {
    expect(roleplayClockText(seconds)).toBe(text);
  });
});
