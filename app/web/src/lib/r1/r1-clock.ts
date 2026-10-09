/**
 * The role-play countdown the candidate sees.
 *
 * The interviewer publishes the seconds of role-play budget left (`rpleft`); it never
 * publishes a wall-clock time, because the candidate's device clock can be minutes off. The
 * page counts down locally from the moment the value ARRIVED, measured with the monotonic
 * `performance.now()`, and only while the role-play is actually running:
 *
 *   - It runs in `roleplay` and nowhere else. The worker's own budget stops during an aside
 *     and while the candidate is disconnected, so the displayed value is frozen then.
 *   - Leaving the role-play freezes it at the value the page had counted down to, and
 *     entering it again restarts the count from the held value, so time spent outside the
 *     role-play is never subtracted.
 *   - A fresh `rpleft` from the interviewer always replaces the local count (the worker is the
 *     authority; the 30 second heartbeat keeps the two within a second or two).
 *   - It is an UPPER bound: the interviewer may finish the role-play earlier.
 *
 * Pure functions on plain numbers, so the rules are testable without a clock or a renderer.
 */

import type { R1Phase } from './r1-phase';

export interface R1Clock {
  /** Seconds of role-play budget left as of `at`. */
  seconds: number;
  /** `performance.now()` (milliseconds) when `seconds` was true. */
  at: number;
}

/** A clock that reads `seconds` at `now`. */
export function anchorClock(seconds: number, now: number): R1Clock {
  return { seconds, at: now };
}

/** Seconds left at `now`: counted down from the anchor while `running`, held while not. */
export function clockSecondsLeft(clock: R1Clock, running: boolean, now: number): number {
  const elapsed = running ? Math.max(0, (now - clock.at) / 1000) : 0;
  return Math.max(0, clock.seconds - elapsed);
}

/**
 * The clock after the phase moved from `from` to `to`: frozen at its current value when the
 * role-play stops, restarted from the held value when it starts. Null stays null.
 */
export function retimeClock(
  clock: R1Clock | null,
  from: R1Phase | null,
  to: R1Phase,
  now: number,
): R1Clock | null {
  if (clock === null) return null;
  if (from === 'roleplay' && to !== 'roleplay') {
    return anchorClock(clockSecondsLeft(clock, true, now), now);
  }
  if (from !== 'roleplay' && to === 'roleplay') return anchorClock(clock.seconds, now);
  return clock;
}

/**
 * What the timer says for `secondsLeft`: whole minutes rounded up ("8 min left"), "under a
 * minute" below sixty seconds, "wrapping up" at zero. It changes once a minute, so it can be
 * recomputed every second without announcing or repainting anything in between.
 */
export function roleplayClockText(secondsLeft: number): string {
  const seconds = Number.isFinite(secondsLeft) ? Math.max(0, secondsLeft) : 0;
  if (seconds <= 0) return 'Role-play · wrapping up';
  if (seconds < 60) return 'Role-play · under a minute left';
  return `Role-play · ${Math.ceil(seconds / 60)} min left`;
}
