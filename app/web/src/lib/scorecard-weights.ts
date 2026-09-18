/**
 * Client-side scorecard weight math for the role editor.
 *
 * Weights are TYPED per metric (owner request 2026-09-18), so nothing here
 * rebalances a set in response to an edit: `totalWeightBps`, `weightDeltaBps`,
 * `everyWeightIsPositive` and `weightsAreComplete` only REPORT on the set the
 * owner has typed, and the editor blocks Save until it totals exactly 10000
 * bps. Nothing here writes a weight at all — attaching a metric hands it
 * whatever is left of 10000 bps and removing one simply drops it, so a number
 * the owner typed is never rewritten by anything but the owner.
 *
 * `redistributeWeights` (pin one metric, spread the remainder) lived here to
 * give the old weight SLIDER instant feedback that matched the server exactly.
 * It was removed with the slider; the server endpoint behind
 * `api.redistributeRoleScorecardWeights` remains the only implementation.
 *
 * The server stays authoritative on save — PUT re-validates the whole set.
 */

export const SCORECARD_WEIGHT_TOTAL_BPS = 10000;

/** The subset of a metric these calculators need — anything with weight + order. */
export interface WeightedMetric {
  id: string;
  weightBps: number;
  displayOrder: number;
}

/** Sum of weights in bps. */
export function totalWeightBps(metrics: readonly WeightedMetric[]): number {
  return metrics.reduce((sum, m) => sum + (Number(m.weightBps) || 0), 0);
}

/** True when the working set totals exactly 10000 bps. */
export function weightsAreComplete(metrics: readonly WeightedMetric[]): boolean {
  return totalWeightBps(metrics) === SCORECARD_WEIGHT_TOTAL_BPS;
}

/**
 * Signed distance from a complete set, in bps: negative = short, positive = over.
 *
 * The editor types weights directly rather than dragging a slider that
 * auto-balanced them, so the set can legitimately sit at 97% or 104% while an
 * owner is part-way through editing. This is what the running total needs in
 * order to say HOW FAR off it is, which is the whole point of showing it.
 */
export function weightDeltaBps(metrics: readonly WeightedMetric[]): number {
  return totalWeightBps(metrics) - SCORECARD_WEIGHT_TOTAL_BPS;
}

/**
 * True when every metric carries at least 1 bps (0.01%).
 *
 * The server's domain validator rejects a zero weight, so a set that totals
 * exactly 100% can still be refused if one metric was typed to 0 and another
 * absorbed the difference. Checked separately from the total so the editor can
 * say which of the two problems it is.
 */
export function everyWeightIsPositive(metrics: readonly WeightedMetric[]): boolean {
  return metrics.every((m) => (Number(m.weightBps) || 0) >= 1);
}

/** bps → percent number (10000 → 100, 2550 → 25.5). */
export function bpsToPercent(bps: number): number {
  return bps / 100;
}

/** bps → a compact percent label, e.g. `25%`, `33.33%`. */
export function formatWeightPercent(bps: number): string {
  const pct = bpsToPercent(bps);
  // Trim trailing zeros: 2500 → "25%", 3333 → "33.33%", 1250 → "12.5%".
  const rounded = Math.round(pct * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded : Number(rounded.toFixed(2))}%`;
}
