/**
 * The screening scoreboard's rate arithmetic, as pure functions: the rules
 * most easily broken and least visibly tested, kept apart from the component
 * so they are asserted directly.
 */
import type { FunnelDailyRow } from '../../types';
import { formatDayLabel } from '../charts/dates';

/**
 * A ratio as a whole-number percent, or null when the denominator is zero.
 * Null renders as "—": a rate with no denominator is unknown, not zero.
 */
export function pct(num: number, den: number): number | null {
  if (!den || den <= 0) return null;
  // A share cannot exceed its whole. `connected` and `dialed` come from
  // different writers, so a missed dial row or a late carrier webhook can make
  // it so, and "Connect rate 267%" beside "Candidates dialled 3" is not a
  // number anyone should try to interpret. Unknown, not clamped to 100: a
  // silent clamp would read as a real, perfect result.
  if (num > den) return null;
  return Math.round((num / den) * 100);
}

export function pctLabel(value: number | null): string {
  return value === null ? '—' : `${value}%`;
}

/**
 * Build a rate series, DROPPING days whose denominator is zero.
 *
 * Exported because this is the rule most easily broken and least visibly
 * tested: asserting it through a rendered ECharts canvas means asserting on a
 * data table that may not exist in jsdom, which silently turns the test into a
 * no-op. A `?? 0` here would plot "unknown" as a hard zero: a weekend with no
 * dials rendering as a connect-rate cliff, indistinguishable from every phone
 * line failing, and directly contradicting the figure behaviour above.
 */
export function buildRateSeries(
  rows: FunnelDailyRow[],
  num: (row: FunnelDailyRow) => number | undefined,
  den: (row: FunnelDailyRow) => number | undefined,
): Array<{ label: string; value: number }> {
  return rows
    .map((row) => ({
      // "3 Sep": the one date format every chart on the page uses.
      label: formatDayLabel(row.cohort_day),
      // The accessors may return `undefined`: this route DELETES fields from a
      // series row. An absent denominator falls to 0, which `pct` reports as
      // unknown and the filter then drops: the same answer as a real zero
      // denominator, and the right one.
      value: pct(num(row) ?? 0, den(row) ?? 0),
    }))
    .filter((p): p is { label: string; value: number } => p.value !== null);
}

