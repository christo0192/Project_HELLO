/**
 * ashby/scorecard-v2-adapter.ts — pure, DB-free adapter from a PERSISTED v2
 * scorecard assessment row (schema_version=2) into the provider-neutral
 * {@link ScorecardSource} shape that {@link buildScorecard} + {@link
 * bindFeedbackForm} already consume.
 *
 * WHY THIS EXISTS: the legacy ScorecardSource builders in workflow-stores.ts
 * read the v1 dimension columns (english/tone/communication/motivation/
 * role_fit). A v2 row leaves every one of those columns NULL, so those builders
 * would silently produce all-zero dimensions for a v2 assessment. This module is
 * the v2-shaped equivalent: one dimension per SCORED metric, keyed by the metric
 * key and carrying the metric's dashboard NAME (what the auto-binder matches to
 * a form field title) and its own 1–5 score (submitted 1:1 on a five-point
 * field), with the overall taken from the persisted weighted 1–5 score via the
 * SAME domain function the scorer used.
 *
 * WIRED since #275 (owner decision 2026-09-10): both build sites in
 * workflow-stores.ts branch on `schema_version` and call this for v2 rows.
 *
 * SUMMARY — the recruiter-facing "why". Owner decision (#275): the Summary
 * field carries one line per metric — "<Name> — <score>/5: <rationale>" — so a
 * recruiter reading the Ashby card sees the reasoning, not just numbers. Each
 * rationale is bounded and control-stripped; the whole summary is bounded by
 * `buildScorecard` (2000 chars) and trimmed here on whole lines so no rationale
 * is cut mid-sentence. Metrics with insufficient evidence are listed as such.
 * The evidence refs (transcript turn ids) are NEVER copied.
 *
 * FAIL-CLOSED (mirrors buildScorecard's reason union): rather than invent an
 * overall for an evidence-incomplete assessment or emit a fabricated 0 for a
 * metric that was never scored, the adapter returns `{ blocked: <reason> }`.
 */

import {
  isScoreOnScale,
  isScoreScaleMax,
  SCORE_MAX,
  SCORECARD_MAX_METRICS,
  SCORECARD_SCHEMA_VERSION,
  type ScoreScaleMax,
} from '../../lib/scorecards/contracts.js';
import { weightedScoreToOverall } from '../../lib/scorecards/domain.js';
import { RECOMMENDATIONS, stripLoneSurrogates, type Recommendation, type ScorecardSource } from './scorecard.js';
import { ROLE_FIT_DIMENSION, normalizeTitle } from './scorecard-autobind.js';

/**
 * Metric score (on the row's own rubric scale) → the 0–10 dimension scale.
 *
 * Mapping: `round(metricScore / scaleMax * 10)`. On the four-level rubric
 * (0093) that is 1→3, 2→5, 3→8, 4→10; on a pre-0093 five-level row it is the
 * historical 1→2, 2→4, 3→6, 4→8, 5→10 (`metricScore * 2`). Chosen over
 * `((score-1)/(max-1))*10` (which would map 1→0) because every genuinely
 * scored metric must stay strictly POSITIVE: a scored-but-poor metric can never
 * be confused with a metric that was OMITTED for lack of evidence (absent from
 * the dimension list). That is the whole point of not emitting a fabricated 0.
 * buildScorecard clamps dimension scores to 0–10 and rounds, so these pass
 * through unchanged. The 0–10 projection is only a fallback: when the bound
 * Ashby field's scale equals the rubric scale the metric score is written 1:1.
 */
export function metricScoreToDimensionScore(metricScore: number, scaleMax: number = SCORE_MAX): number {
  return Math.round((metricScore / scaleMax) * 10);
}

/** Bounds for the rich summary. The whole summary is further capped by buildScorecard. */
export const MAX_SUMMARY_RATIONALE_LEN = 280;
export const MAX_SUMMARY_TOTAL_LEN = 2000;
const MAX_METRIC_NAME_LEN = 100;

/**
 * The subset of a persisted `assessments` row the adapter reads. Every field is
 * optional and loosely typed because `metric_results`/`provenance` arrive as
 * jsonb; the adapter validates defensively rather than trusting the shape.
 */
export interface PersistedV2AssessmentRow {
  readonly schema_version?: number | null;
  readonly scoring_status?: string | null;
  /**
   * Rubric scale the row was scored on (0093): 4 today, 5 for pre-0093 rows.
   * Absent/invalid → treated as the CURRENT scale (`SCORE_MAX`); the metric
   * scores are then range-checked against it, so a mis-tagged row fails closed
   * rather than mis-projecting.
   */
  readonly score_scale_max?: number | null;
  readonly weighted_score_5?: number | null;
  readonly recommendation?: string | null;
  /** jsonb array of ScorecardMetricResult ({ metric: { key, name }, score, evidenceStatus, rationale, … }). */
  readonly metric_results?: unknown;
  /** jsonb scoring provenance ({ requestedModel, prompt_template_version, … }). */
  readonly provenance?: unknown;
  /** jsonb v1-shaped role fit written by the v2 integrity pass (#282); only `red_flags` is read. */
  readonly role_fit?: unknown;
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
  /** Opaque Ashby application id, when the caller has it (execute-time needs it). */
  readonly externalApplicationId?: string;
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

/** The metric display name, bounded; falls back to the key so a line is never nameless. */
function readMetricName(entry: Record<string, unknown>, key: string): string {
  const metric = asObject(entry.metric);
  const name = metric?.name;
  const cleaned = typeof name === 'string' ? cleanText(name, MAX_METRIC_NAME_LEN) : '';
  return cleaned.length > 0 ? cleaned : key;
}

/** Strip control characters, collapse whitespace, bound. */
function cleanText(raw: string, max: number): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f) ? ' ' : ch;
  }
  // Truncation cuts UTF-16 code units, so an emoji or other astral character
  // on the boundary would leave an orphaned surrogate half in the JSON body —
  // which a provider may reject outright. Drop those halves, as the red-flag
  // normalizer already does.
  out = stripLoneSurrogates(out).replace(/\s+/g, ' ').trim();
  return out.length > max ? `${stripLoneSurrogates(out.slice(0, max - 1)).trimEnd()}…` : out;
}

function formatWeighted(weighted: number): string {
  // calculateWeightedScore already rounds to 4 dp; present at most 2.
  return String(Math.round(weighted * 100) / 100);
}

/**
 * The recruiter-facing summary: a header line, then one bounded line per
 * metric in the order they were configured. Lines are added whole until the
 * total budget is reached, so a rationale is never cut mid-sentence by the
 * summary bound (individual rationales are bounded separately).
 */
export function buildV2RichSummary(
  weighted: number,
  lines: readonly string[],
  maxTotalLen: number = MAX_SUMMARY_TOTAL_LEN,
  scaleMax: number = SCORE_MAX,
): string {
  const header = `AI phone screen — weighted ${formatWeighted(weighted)}/${scaleMax} across ${lines.length} metric${lines.length === 1 ? '' : 's'}.`;
  let out = header;
  for (const line of lines) {
    const candidate = `${out}\n${line}`;
    if (candidate.length > maxTotalLen) break;
    out = candidate;
  }
  return out;
}

/**
 * Adapt a persisted v2 assessment row into a {@link ScorecardSource}, or return
 * `{ blocked }` when the row cannot be mapped safely.
 *
 * IMPORTANT for bind-time behaviour: the produced dimensions are keyed by the
 * configured METRIC KEY and carry the metric NAME. The auto-binder
 * (`scorecard-autobind.ts`) matches the name to a Score field title on the
 * tenant form; a metric with no matching field is OMITTED by
 * `bindFeedbackForm` — that is the intended fail-safe (an unmapped metric is
 * never guessed onto a field).
 */
export function scorecardSourceFromV2Assessment(
  row: PersistedV2AssessmentRow,
  options: ScorecardSourceFromV2Options,
): V2AdapterResult {
  // 1. v2 only — this adapter never reinterprets a v1 row.
  if (Number(row?.schema_version) !== SCORECARD_SCHEMA_VERSION) {
    return { blocked: 'not_v2' };
  }

  // 2. Fail closed on anything less than fully-evidenced. Since partial scoring
  //    (0091) an 'incomplete_evidence' row MAY carry a provisional weighted score,
  //    but that verdict is NOT authoritative for an Ashby writeback — a human must
  //    confirm it first. So this gate keys on STATUS: only a 'complete' row flows
  //    on; any non-'complete' status is blocked here (the weighted null/range check
  //    below is then a defensive backstop, unreachable for a complete row).
  if (row.scoring_status !== 'complete') {
    return { blocked: 'incomplete_evidence' };
  }
  // The row's own rubric scale (0093). Absent → current scale.
  const scaleMax: ScoreScaleMax = isScoreScaleMax(row.score_scale_max) ? row.score_scale_max : SCORE_MAX;
  const weighted = row.weighted_score_5;
  if (typeof weighted !== 'number' || !Number.isFinite(weighted) || weighted < 1 || weighted > scaleMax) {
    return { blocked: 'incomplete_evidence' };
  }
  // Reuse the domain function (single source of truth for rubric → 0–100 on
  // the row's scale). Guarded above, so it neither throws nor returns null here.
  const overallScore = weightedScoreToOverall(weighted, scaleMax);
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
  //    as a fabricated 0 — but it is still NAMED in the summary as unscored so
  //    the recruiter knows it was considered. Evidence refs never cross.
  const metricResults = Array.isArray(row.metric_results) ? row.metric_results : [];
  const dimensions: NonNullable<ScorecardSource['dimensions']>[number][] = [];
  const summaryLines: string[] = [];
  for (const raw of metricResults) {
    const entry = asObject(raw);
    if (!entry) continue;
    const key = readMetricKey(entry);
    if (key === null) continue;
    const name = readMetricName(entry, key);
    const rationale = typeof entry.rationale === 'string' ? cleanText(entry.rationale, MAX_SUMMARY_RATIONALE_LEN) : '';
    if (entry.evidenceStatus !== 'scored' || !isScoreOnScale(entry.score, scaleMax)) {
      summaryLines.push(`${name} — not scored (insufficient evidence)${rationale ? `: ${rationale}` : ''}`);
      continue;
    }
    if (dimensions.length < SCORECARD_MAX_METRICS) {
      dimensions.push({
        key,
        name,
        score: metricScoreToDimensionScore(entry.score, scaleMax),
        metricScore: entry.score,
        metricScaleMax: scaleMax,
      });
    }
    summaryLines.push(`${name} — ${entry.score}/${scaleMax}${rationale ? `: ${rationale}` : ''}`);
  }
  if (dimensions.length === 0) return { blocked: 'no_dimensions' };

  // 4b. Role fit (owner request, #275): the tenant form keeps its v1 `Role fit`
  //     Score field, and the v2 integrity pass (#282) writes a v1-shaped
  //     `role_fit.score` on the 0–10 dimension scale. Carry it as ONE extra
  //     dimension named "Role fit" so the auto-binder lands it on that field by
  //     title exactly like a metric; with no `metricScore` it is bucketed onto
  //     the field's scale the way v1 always was. Absent or non-numeric → omitted
  //     (never a fabricated 0); a dashboard metric that itself uses the key
  //     `role_fit` wins and the derived signal is dropped.
  const roleFit = asObject(row.role_fit);
  const roleFitScore = roleFit?.score;
  // (Role fit sits OUTSIDE the SCORECARD_MAX_METRICS cap — it is not a metric —
  //  so a role at the cap still gets it, exactly as the preview promises.)
  // Shadowed by a dashboard metric with the same key OR the same display name:
  // a metric named "Role fit" already claims that form field, and two
  // dimensions must never contend for one field.
  const roleFitTaken = dimensions.some(
    (d) => d.key === ROLE_FIT_DIMENSION.key || normalizeTitle(d.name) === normalizeTitle(ROLE_FIT_DIMENSION.name),
  );
  if (
    typeof roleFitScore === 'number' && Number.isFinite(roleFitScore)
    && roleFitScore >= 0 && roleFitScore <= 10
    && !roleFitTaken
  ) {
    const rounded = Math.round(roleFitScore);
    dimensions.push({ key: ROLE_FIT_DIMENSION.key, name: ROLE_FIT_DIMENSION.name, score: rounded });
    summaryLines.push(`${ROLE_FIT_DIMENSION.name} — ${rounded}/10 (résumé vs role)`);
  }

  // 5. Recruiter-facing summary, bounded on whole lines.
  const summary = buildV2RichSummary(weighted, summaryLines, MAX_SUMMARY_TOTAL_LEN, scaleMax);

  // 6. Provenance — same keys the v1 builder reads, all optional.
  const provenanceObj = asObject(row.provenance) ?? {};
  const model =
    typeof provenanceObj.requestedModel === 'string' ? provenanceObj.requestedModel : undefined;
  const version =
    typeof provenanceObj.prompt_template_version === 'string'
      ? provenanceObj.prompt_template_version
      : undefined;
  const scoredAt = typeof row.created_at === 'string' ? row.created_at : undefined;

  // 7. Red flags: ONLY the persisted `role_fit.red_flags` array (the v2
  //    integrity pass writes the same v1-shaped column, #282). Normalisation and
  //    bounds live in `normalizeRedFlags`, exactly as for v1.
  const redFlags = roleFit && Array.isArray(roleFit.red_flags) ? roleFit.red_flags : [];

  const recommendationValue = recommendation as Recommendation;
  return {
    schemaVersion: 2,
    externalApplicationId: options.externalApplicationId,
    overallScore,
    recommendation: recommendationValue,
    dimensions,
    summary,
    provenance: { model, scoredAt, version },
    reviewPath: options.reviewPath,
    redFlags,
  };
}
