/**
 * The arithmetic of the call strip: where a second sits on the scale, which tick a press means, how
 * moments keep clear of each other, and where the axis prints a time. No React, so each rule is
 * pinned by a plain unit test.
 */

const MAX_LANES = 3;
/** The width the lanes are worked out for. Lanes need no measuring: a little slack is harmless. */
const STRIP_PX = 560;
const AXIS_STEPS_SEC = [60, 120, 300, 600, 900, 1800];
const AXIS_MAX_LABELS = 7;

/** A position along the scale, as a percentage, clamped to it. */
export function along(sec: number, durationSec: number): number {
  if (durationSec <= 0) return 0;
  return Math.min(100, Math.max(0, (sec / durationSec) * 100));
}

/** The nearest tick within `toleranceSec` of `sec`, else `sec`: a tick is a pixel wide. */
export function snapToTick(sec: number, ticks: readonly number[], toleranceSec: number): number {
  let best = sec;
  let bestGap = toleranceSec;
  for (const tick of ticks) {
    const gap = Math.abs(tick - sec);
    if (gap <= bestGap) {
      best = tick;
      bestGap = gap;
    }
  }
  return best;
}

/** The lane of each moment, for `secs` in ascending order: the first that is clear of it. */
export function assignLanes(secs: readonly number[], durationSec: number, gapPx: number, widthPx = STRIP_PX): number[] {
  const lastPx: number[] = [];
  return secs.map((sec) => {
    const px = (along(sec, durationSec) / 100) * widthPx;
    let lane = lastPx.findIndex((last) => px - last >= gapPx);
    if (lane === -1) lane = Math.min(lastPx.length, MAX_LANES - 1);
    lastPx[lane] = px;
    return lane;
  });
}

/** Where the axis prints a time: the first step that keeps the labels readable. */
export function axisSteps(durationSec: number): number[] {
  const step = AXIS_STEPS_SEC.find((candidate) => durationSec / candidate < AXIS_MAX_LABELS) ?? AXIS_STEPS_SEC[AXIS_STEPS_SEC.length - 1];
  const steps: number[] = [];
  for (let at = 0; at <= durationSec; at += step) steps.push(at);
  return steps;
}
