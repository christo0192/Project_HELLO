/**
 * ashby/scorecard-v2-adapter.ts — pure, DB-free adapter from a PERSISTED v2
 * scorecard assessment row (schema_version=2) into the provider-neutral
 * {@link ScorecardSource} shape that {@link buildScorecard} + {@link
 * bindFeedbackForm} already consume.
 *
 * WHY THIS EXISTS: the only existing ScorecardSource builders
 * (`readScorecardSource` / `enqueueScorecardWrite` in workflow-stores.ts) read
 * the LEGACY v1 dimension columns (english/tone/communication/motivation/
 * role_fit). A v2 row leaves every one of those columns NULL, so those builders
 * would silently produce all-zero dimensions for a v2 assessment. This module is
 * the v2-shaped equivalent: one dimension per configured metric, keyed by the
 * metric key, scored on the 0–10 dimension scale, with the overall taken from
 * the persisted weighted 1–5 score via the SAME domain function the scorer used.
 *
 * ┌─ NOT YET WIRED ───────────────────────────────────────────────────────────┐
 * │ This adapter is intentionally NOT called by `enqueueScorecard`,            │
 * │ `enqueueScorecardWrite`, or the operation-worker scorecard branch yet. The │
 * │ live Ashby scorecard writeback still builds its ScorecardSource from v1    │
 * │ columns. Wiring this in (choosing v1 vs v2 by the row's schema_version at  │
 * │ the two build sites) is a separate, later change; until then this file is  │
 * │ exercised only by its unit tests.                                          │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * REDACTION: a produced dimension is ONLY `{ key, score }`. The metric name,
 * rationale, and evidence refs are NEVER copied out — note that the existing
 * `isScorecardSafe` forbidden-KEY scan would NOT catch a leaked `rationale`
 * value (the key name isn't forbidden), so redaction here is by CONSTRUCTION:
 * we read the numeric score and the metric key and nothing else. The summary is
 * a bounded, generated count string — never model rationale text.
 *
 * FAIL-CLOSED (mirrors buildScorecard's reason union): rather than invent an
 * overall for an evidence-incomplete assessment or emit a fabricated 0 for a
 * metric that was never scored, the adapter returns `{ blocked: <reason> }`.
 */

import {
  isScoreValue,
  SCORECARD_MAX_METRICS,
  SCORECARD_SCHEMA_VERSION,
} from '../../lib/scorecards/contracts.js';
import { weightedScoreToOverall } from '../../lib/scorecards/domain.js';
import { RECOMMENDATIONS, type Recommendation, type ScorecardSource } from './scorecard.js';

/**
 * The 1–5 metric score → 0–10 dimension-scale factor.
 *
 * Mapping: `dimensionScore = metricScore * 2`, so 1→2, 2→4, 3→6, 4→8, 5→10.
 * Chosen deliberately over `((score-1)/4)*10` (which would map 1→0):
 *   - it is a plain linear map with each discrete 1–5 landing on a distinct even
 *     value, so it round-trips and is trivially explainable; and
 *   - every genuinely-scored metric stays strictly positive (2–10), so a
 *     scored-but-poor metric (2/10) can never be confused with a metric that was
 *     OMITTED because it had no evidence (absent from the dimension list). That
 *     is the whole point of not emitting a fabricated 0.
 * buildScorecard clamps dimension scores to 0–10 and rounds, so 2/4/6/8/10 pass
 * through unchanged.
 */
export const METRIC_SCORE_TO_DIMENSION_FACTOR = 2 as const;

/** Map one validated 1–5 metric score onto the 0–10 dimension scale. */
export function metricScoreToDimensionScore(metricScore: number): number {
  return metricScore * METRIC_SCORE_TO_DIMENSION_FACTOR;
}

/**
 * The subset of a persisted `assessments` row the adapter reads. Every field is
 * optional and loosely typed because `metric_results`/`provenance` arrive as
 * jsonb; the adapter validates defensively rather than trusting the shape.
 */
export interface PersistedV2AssessmentRow {
  readonly schema_version?: number | null;
  readonly scoring_status?: string | null;
  readonly weighted_score_5?: number | null;
  readonly recommendation?: string | null;
  /** jsonb array of ScorecardMetricResult ({ metric: { key }, score, evidenceStatus, … }). */
  readonly metric_results?: unknown;
  /** jsonb scoring provenance ({ requestedModel, prompt_template_version, … }). */
  readonly provenance?: unknown;
  /** Row insert time — used only as `provenance.scoredAt`. */
  readonly created_at?: string | null;
}

export interface ScorecardSourceFromV2Options {
  /**
   * The canonical relative review path, e.g. from `ashbyReviewPath(linkId)`.
   * Passed straight through; buildScorecard remains the single authority that
   * validates it (`invalid_review_path`) — the adapter does not re-check it.
   */
  readonly reviewPath: string;
}

/**
 * Fail-closed reasons, deliberately parallel to buildScorecard's:
 *   - `not_v2`               — the row is not a schema_version=2 assessment;
 *   - `incomplete_evidence`  — scoring_status !== 'complete' or the weighted 1–5
 *                              score is null/out-of-range (no overall may be
 *                              invented — matches the scorer nulling the weighted
 *                              score whenever any metric lacked evidence);
 *   - `no_dimensions`        — no metric survived to a scored dimension;
 *   - `invalid_recommendation` — a 'complete' row without a valid
 *                              advance/hold/reject recommendation (data-integrity
 *                              guard; the adapter never defaults it silently).
 */
export type V2AdapterBlockReason =
  | 'not_v2'
  | 'incomplete_evidence'
  | 'no_dimensions'
  | 'invalid_recommendation';

export type V2AdapterResult = ScorecardSource | { readonly blocked: V2AdapterBlockReason };

/** True iff the adapter fail-closed instead of producing a source. */
export function isV2AdapterBlocked(
  result: V2AdapterResult,
): result is { readonly blocked: V2AdapterBlockReason } {
  return typeof result === 'object' && result !== null && 'blocked' in result;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The metric key of one persisted metric-result entry, or null if unusable. */
function readMetricKey(entry: Record<string, unknown>): string | null {
  const metric = asObject(entry.metric);
  const key = metric?.key;
  return typeof key === 'string' && key.length > 0 ? key : null;
}

function formatWeighted(weighted: number): string {
  // calculateWeightedScore already rounds to 4 dp; present at most 2.
  return String(Math.round(weighted * 100) / 100);
}

/**
 * Adapt a persisted v2 assessment row into a {@link ScorecardSource}, or return
 * `{ blocked }` when the row cannot be mapped safely.
 *
 * IMPORTANT for bind-time behaviour: the produced dimensions are keyed by the
 * configured METRIC KEY. Any key that lacks an entry in a tenant's
 * `ScorecardFormBinding.dimensionFieldIds` (equivalently `fieldPaths.dimensions`)
 * is OMITTED by `bindFeedbackForm` — that is the intended fail-safe (an unmapped
 * metric is never guessed onto a field). Adding a new metric to a role therefore
 * requires adding its key to the tenant binding, or its dimension will not be
 * submitted to Ashby.
 */
export function scorecardSourceFromV2Assessment(
  row: PersistedV2AssessmentRow,
  options: ScorecardSourceFromV2Options,
): V2AdapterResult {
  // 1. v2 only — this adapter never reinterprets a v1 row.
  if (Number(row?.schema_version) !== SCORECARD_SCHEMA_VERSION) {
    return { blocked: 'not_v2' };
  }

  // 2. Fail closed on incomplete evidence: no overall may be invented. The
  //    scorer nulls weighted_score_5 whenever any metric lacked evidence, so a
  //    non-'complete' status or a null/out-of-range weighted score is blocked.
  if (row.scoring_status !== 'complete') {
    return { blocked: 'incomplete_evidence' };
  }
  const weighted = row.weighted_score_5;
  if (typeof weighted !== 'number' || !Number.isFinite(weighted) || weighted < 1 || weighted > 5) {
    return { blocked: 'incomplete_evidence' };
  }
  // Reuse the domain function (single source of truth for 1–5 → 0–100). Guarded
  // above, so it neither throws nor returns null here.
  const overallScore = weightedScoreToOverall(weighted);
  if (overallScore === null) return { blocked: 'incomplete_evidence' };

  // 3. Recommendation pass-through. A 'complete' row stores advance/hold/reject
  //    ('human_review' only ever accompanies incomplete evidence, already
  //    blocked above). Never silently default it.
  const recommendation = row.recommendation;
  if (
    typeof recommendation !== 'string' ||
    !(RECOMMENDATIONS as readonly string[]).includes(recommendation)
  ) {
    return { blocked: 'invalid_recommendation' };
  }

  // 4. One dimension per SCORED metric. A metric with a null / non-1–5 score, a
  //    non-'scored' evidence status, or no usable key is OMITTED — never emitted
  //    as a fabricated 0. Only key + numeric score cross the boundary; name,
  //    rationale, and evidence refs are dropped by construction.
  const metricResults = Array.isArray(row.metric_results) ? row.metric_results : [];
  const dimensions: { key: string; score: number }[] = [];
  for (const raw of metricResults) {
    const entry = asObject(raw);
    if (!entry) continue;
    if (entry.evidenceStatus !== 'scored') continue;
    if (!isScoreValue(entry.score)) continue;
    const key = readMetricKey(entry);
    if (key === null) continue;
    dimensions.push({ key, score: metricScoreToDimensionScore(entry.score) });
    if (dimensions.length >= SCORECARD_MAX_METRICS) break; // ≤ MAX_DIMENSIONS (buildScorecard also caps)
  }
  if (dimensions.length === 0) return { blocked: 'no_dimensions' };

  // 5. Bounded, redaction-safe summary: counts only, never model text.
  const summary = `${dimensions.length} metric${dimensions.length === 1 ? '' : 's'} scored; weighted ${formatWeighted(weighted)}/5.`;

  // 6. Provenance — same keys the v1 builder reads, all optional.
  const provenanceObj = asObject(row.provenance) ?? {};
  const model =
    typeof provenanceObj.requestedModel === 'string' ? provenanceObj.requestedModel : undefined;
  const version =
    typeof provenanceObj.prompt_template_version === 'string'
      ? provenanceObj.prompt_template_version
      : undefined;
  const scoredAt = typeof row.created_at === 'string' ? row.created_at : undefined;

  const recommendationValue = recommendation as Recommendation;
  return {
    overallScore,
    recommendation: recommendationValue,
    dimensions,
    summary,
    provenance: { model, scoredAt, version },
    reviewPath: options.reviewPath,
    // v2 carries no `role_fit.red_flags` array; leave red flags unset so
    // renderRedFlags submits the honest "None identified" sentinel.
  };
}
