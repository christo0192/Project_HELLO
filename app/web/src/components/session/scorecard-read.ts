/**
 * Defensive reads behind the session scorecard views.
 *
 * Assessment rows are persisted JSON from two model generations and have
 * been reshaped more than once, so nothing here trusts a field's type: every
 * value is read as `unknown` and anything unreadable becomes null (shown as
 * "Not scored", "Insufficient evidence", or left out), never a throw inside
 * render and never a number the model did not produce.
 */

import { isAssessmentV2, readScorecardAssessmentV2 } from '../../types';
import type { Assessment, ScorecardAssessmentDisplay } from '../../types';
import { humanizeEnum } from '../../lib/humanize';
import type { StatusTone } from '../design';

/**
 * How a scorecard lays itself out. `stacked` (default) suits a column;
 * `split` suits a full-width host: from `lg` up, each item's heading takes a
 * left column and its detail a right one, instead of one line of prose
 * stretching across the page with its reading stranded at the far edge.
 */
export type ScorecardLayout = 'stacked' | 'split';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A finite number, or null. Accepts numeric strings (the wire is not always typed). */
export function finiteNumber(value: unknown): number | null {
  const n =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

const RECOMMENDATION: Record<string, { label: string; tone: StatusTone }> = {
  advance: { label: 'Advance', tone: 'success' },
  hold: { label: 'Hold', tone: 'warning' },
  reject: { label: 'Reject', tone: 'danger' },
  human_review: { label: 'Needs human review', tone: 'warning' },
};

/**
 * Words and tone for a recommendation. An unknown value is shown plainly
 * (humanized, neutral) rather than dressed up as "Hold": inventing a verdict
 * is worse than showing an unfamiliar one. Absent → null (no pill).
 */
export function recommendationMeta(value: unknown): { label: string; tone: StatusTone } | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return RECOMMENDATION[value] ?? { label: humanizeEnum(value), tone: 'neutral' };
}

/** The row with every non-object metric entry removed, so the v2 reader cannot throw on one. */
function cleaned(assessment: Assessment): Assessment {
  const row = assessment as unknown as Record<string, unknown>;
  const raw = isRecord(row.raw) ? row.raw : null;
  const rawResults = raw && Array.isArray(raw.metricResults) ? raw.metricResults.filter(isRecord) : null;
  return {
    ...assessment,
    raw: (raw ? { ...raw, ...(rawResults ? { metricResults: rawResults } : {}) } : null) as Assessment['raw'],
    metric_results: (Array.isArray(row.metric_results)
      ? row.metric_results.filter(isRecord)
      : []) as unknown as Assessment['metric_results'],
  };
}

/**
 * The v2 display model, or null when the row is not v2 or cannot be read at
 * all. `readScorecardAssessmentV2` trusts the shape of `raw` and
 * `metric_results`; a null entry in either would throw, so the row is
 * cleaned first and the read is still guarded.
 */
export function readRoleScorecard(assessment: Assessment): ScorecardAssessmentDisplay | null {
  if (!isAssessmentV2(assessment)) return null;
  try {
    return readScorecardAssessmentV2(cleaned(assessment));
  } catch {
    return null;
  }
}
