/**
 * Client-side scorecard weight math.
 *
 * This is a FAITHFUL mirror of `redistributeWeights` in the API's
 * app/api/src/lib/scorecards/domain.ts, so the role scorecard slider can
 * re-balance weights instantly (and offline in tests) with the EXACT same
 * deterministic result the server would return — largest-remainder rounding
 * with display-order tie-breaking, output always totalling 10000 bps.
 *
 * The role editor uses `redistributeWeights` on a slider change (pin one metric,
 * spread the remainder proportionally over the others) and `evenWeights` when
 * the metric SET changes (attach/remove), so the working set always totals
 * exactly 100%. The server remains authoritative on save (PUT re-validates the
 * whole set); these helpers only keep the editor honest between saves.
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

function clampInt(value: number, min: number, max: number): number {
  const n = Math.round(Number(value) || 0);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/**
 * Pin `editedMetricId` at `newWeightBps` and redistribute the remaining bps over
 * every other metric proportionally to its current weight, using
 * largest-remainder rounding with display-order tie-breaking. Returns a new
 * array (sorted by displayOrder, matching the server) whose weights total 10000.
 *
 * `newWeightBps` is clamped to [1, 10000 - (others.length)] so every other
 * metric can still hold at least a whole bps — the same envelope the server's
 * domain validator enforces.
 *
 * Every OTHER metric ends at >= 1 bps: 1 bps is RESERVED per other metric, only
 * the surplus (`remainder - others.length`) is spread by the largest-remainder
 * rule, and the reserved 1 is added back. Without this the proportional split
 * can floor a small-weight metric to 0 (e.g. pinning one metric near 100% twice)
 * — an invalid weight the server would 400. This is BYTE-IDENTICAL to the
 * server's app/api/src/lib/scorecards/domain.ts redistributeWeights.
 */
export function redistributeWeights<T extends WeightedMetric>(
  metrics: readonly T[],
  editedMetricId: string,
  newWeightBps: number,
): T[] {
  const ordered = [...metrics].sort((a, b) => a.displayOrder - b.displayOrder);
  const edited = ordered.find((m) => m.id === editedMetricId);
  if (!edited) return ordered;

  const others = ordered.filter((m) => m.id !== editedMetricId);
  if (others.length === 0) {
    return ordered.map((m) => ({ ...m, weightBps: SCORECARD_WEIGHT_TOTAL_BPS }));
  }

  const pinned = clampInt(newWeightBps, 1, SCORECARD_WEIGHT_TOTAL_BPS - others.length);
  const remainder = SCORECARD_WEIGHT_TOTAL_BPS - pinned;
  // Reserve 1 bps per other metric so none can floor to 0; distribute only the
  // surplus proportionally, then add the reserved 1 back. The clamp above keeps
  // `remainder >= others.length`, so `distributable` is never negative.
  const distributable = remainder - others.length;
  const oldOtherTotal = others.reduce((sum, m) => sum + m.weightBps, 0);

  const shares = others.map((metric) => {
    const numerator = oldOtherTotal > 0 ? distributable * metric.weightBps : distributable;
    const denominator = oldOtherTotal > 0 ? oldOtherTotal : others.length;
    const floor = Math.floor(numerator / denominator);
    return { metric, floor, fractional: numerator % denominator };
  });

  let unallocated = distributable - shares.reduce((sum, s) => sum + s.floor, 0);
  shares.sort(
    (a, b) => b.fractional - a.fractional || a.metric.displayOrder - b.metric.displayOrder,
  );
  const redistributed = new Map(shares.map((s) => [s.metric.id, s.floor + 1]));
  for (const share of shares) {
    if (unallocated-- <= 0) break;
    redistributed.set(share.metric.id, (redistributed.get(share.metric.id) ?? 0) + 1);
  }

  return ordered.map((m) =>
    m.id === editedMetricId
      ? { ...m, weightBps: pinned }
      : { ...m, weightBps: redistributed.get(m.id)! },
  );
}

/**
 * Distribute 10000 bps as evenly as possible across the set (largest-remainder,
 * display-order tie-break), so an attach/remove leaves a valid total. Every
 * metric receives at least 1 bps.
 */
export function evenWeights<T extends WeightedMetric>(metrics: readonly T[]): T[] {
  const ordered = [...metrics].sort((a, b) => a.displayOrder - b.displayOrder);
  const n = ordered.length;
  if (n === 0) return ordered;
  if (n > SCORECARD_WEIGHT_TOTAL_BPS) {
    // Degenerate — cannot give each a whole bps. Fall back to 1 each (invalid
    // total, but the UI never reaches this: the metric cap is 20).
    return ordered.map((m) => ({ ...m, weightBps: 1 }));
  }
  const base = Math.floor(SCORECARD_WEIGHT_TOTAL_BPS / n);
  let unallocated = SCORECARD_WEIGHT_TOTAL_BPS - base * n;
  return ordered.map((m) => {
    const extra = unallocated > 0 ? 1 : 0;
    if (unallocated > 0) unallocated -= 1;
    return { ...m, weightBps: base + extra };
  });
}
