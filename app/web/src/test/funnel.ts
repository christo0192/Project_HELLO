/**
 * Funnel fixtures for suites that mock `api` by hand.
 *
 * The candidates page charts a per-role pipeline, which fans out one
 * `/api/funnel/summary` call per role on mount. Suites that build their own
 * `api` mock must carry `getScreeningFunnel` or the page throws before it
 * renders — so this file exists to keep that fixture in ONE place rather than
 * as four drifting copies of a 23-field object.
 *
 * `EMPTY_FUNNEL_TOTALS` zeroes everything, which makes the panel render
 * nothing: a suite that is not testing the chart keeps measuring exactly what
 * it measured before the chart existed.
 */
import type { FunnelSummaryTotals } from '../types';

export const EMPTY_FUNNEL_TOTALS: FunnelSummaryTotals = {
  entered_parse: 0,
  parsed_ok: 0,
  needs_review: 0,
  parse_failed: 0,
  dialed: 0,
  connected: 0,
  consent_passed: 0,
  consent_dropped: 0,
  answered_ge1: 0,
  scored: 0,
  qualified: 0,
  on_hold: 0,
  disqualified: 0,
  human_review: 0,
  reached_reference_check: 0,
  attempts_total: 0,
  connects_total: 0,
  total_call_seconds: 0,
  hr_qualified: 0,
  hr_disqualified: 0,
  hr_awaiting: 0,
  hr_unknown: 0,
  candidates_total: 0,
};

/** A cohort with people in it, for suites that DO assert on the chart. */
export function funnelTotals(over: Partial<FunnelSummaryTotals> = {}): FunnelSummaryTotals {
  return { ...EMPTY_FUNNEL_TOTALS, ...over };
}
