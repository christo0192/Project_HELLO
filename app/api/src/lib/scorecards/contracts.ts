import type { Assessment } from '../types.js';

export const SCORECARD_SCHEMA_VERSION = 2 as const;
export const SCORECARD_WEIGHT_TOTAL_BPS = 10_000 as const;
export const SCORECARD_MAX_METRICS = 20 as const;
export const SCORECARD_MAX_NAME_LENGTH = 100 as const;
export const SCORECARD_MAX_INSTRUCTION_LENGTH = 1_000 as const;
export const SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH = 500 as const;
export const SCORECARD_MAX_RATIONALE_LENGTH = 1_000 as const;
export const SCORECARD_MAX_EVIDENCE_REFS = 10 as const;
/**
 * Per-entry evidenceRefs limit (UTF-16 units). Same value the validator always
 * enforced as a bare literal; named so the prompt, the normalizer and the
 * validator can never drift apart. The prompt asks for 80 to leave headroom.
 */
export const SCORECARD_MAX_EVIDENCE_REF_LENGTH = 100 as const;

/**
 * Stable, PII-free codes for every ScorecardValidationError throw site.
 *
 * WHY: the queue stores only an error message that matches
 * `^[a-z][a-z0-9_.:-]{2,63}$` (runner.ts sanitizeErrorCode); every sentence-style
 * validation message collapsed to 'unknown_error', so a DLQ'd scorecard never
 * said WHICH rule rejected the model output. Each code also passes the logger's
 * SAFE_IDENT_RE and the v_funnel_failures regex, so it can be logged as
 * `rejection_reason` and stored in job_queue/job_dlq verbatim.
 *
 * 'scorecard_invalid:config' is the default and covers every failure of the
 * recruiter-authored configuration (metrics, rubric, weights, scale): those are
 * never repaired by re-asking the model.
 */
export const SCORECARD_VALIDATION_CODES = [
  'scorecard_invalid:config',
  // parseResults (scorer.ts): the top-level output shape
  'scorecard_invalid:output_not_object',
  'scorecard_invalid:results_missing',
  'scorecard_invalid:result_not_object',
  // validateMetricResults (domain.ts): count and ids
  'scorecard_invalid:result_count',
  'scorecard_invalid:unknown_metric_id',
  'scorecard_invalid:duplicate_metric_id',
  // status and score pairing
  'scorecard_invalid:evidence_status',
  'scorecard_invalid:score_not_integer_1_4',
  'scorecard_invalid:insufficient_with_score',
  // rationale (a non-text rationale reports rationale_empty)
  'scorecard_invalid:rationale_empty',
  'scorecard_invalid:rationale_too_long',
  // evidence refs
  'scorecard_invalid:evidence_refs_not_array',
  'scorecard_invalid:evidence_refs_too_many',
  'scorecard_invalid:evidence_ref_not_string',
  'scorecard_invalid:evidence_ref_too_long',
] as const;
export type ScorecardValidationCode = (typeof SCORECARD_VALIDATION_CODES)[number];

/**
 * One label per presentation-only fix normalizeModelResults may apply. Each
 * applied rule is logged as its own event (never joined), so after deploy the
 * logs show which benign output classes actually occur — truncation makes
 * evidence_ref_too_long unreachable, so the rule log is the only witness left.
 */
export const SCORECARD_NORMALIZATION_RULES = [
  'evidence_ref_truncated',
  'evidence_refs_capped',
  'evidence_refs_coerced_array',
  'evidence_ref_dropped',
  'rationale_truncated',
  'score_string_coerced',
  'insufficient_score_nullified',
  'evidence_status_canonicalized',
  'metric_id_trimmed',
  'extra_keys_stripped',
] as const;
export type ScorecardNormalizationRule = (typeof SCORECARD_NORMALIZATION_RULES)[number];

/**
 * Rubric scale — FOUR levels since 2026-09-10 (owner decision, #275/#284):
 * Ashby `Score` fields are four-point, so the dashboard rubric uses the same
 * four levels and a metric score is written to Ashby 1:1 with no bucketing.
 * Assessments scored before migration 0093 carry `scoreScaleMax = 5` and keep
 * their 1–5 scores; see {@link LEGACY_SCORE_LABELS_5}.
 */
export const SCORE_MIN = 1 as const;
export const SCORE_MAX = 4 as const;
/** Every scale a persisted assessment may carry (`assessments.score_scale_max`). */
export const SCORE_SCALE_MAX_VALUES = [4, 5] as const;
export type ScoreScaleMax = (typeof SCORE_SCALE_MAX_VALUES)[number];

export const SCORE_LABELS = {
  1: 'Poor',
  2: 'Average',
  3: 'Good',
  4: 'Excellent',
} as const;

/** Labels of the retired five-level scale, for DISPLAY of pre-0093 assessments only. */
export const LEGACY_SCORE_LABELS_5 = {
  1: 'Poor',
  2: 'Below average',
  3: 'Average',
  4: 'Good',
  5: 'Excellent',
} as const;

export type ScoreValue = keyof typeof SCORE_LABELS;
export type ScorecardRubric = Record<ScoreValue, string>;
export type MetricEvidenceStatus = 'scored' | 'insufficient_evidence';
export type ScorecardAssessmentStatus = 'complete' | 'incomplete_evidence';

export interface ScorecardMetricTemplate {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly defaultInstruction: string;
  readonly rubric: ScorecardRubric;
  readonly archivedAt: string | null;
  readonly version: number;
}

/** Immutable metric snapshot attached to one immutable role configuration. */
export interface RoleScorecardMetric {
  readonly id: string;
  readonly libraryMetricId: string;
  readonly key: string;
  readonly name: string;
  readonly instruction: string;
  readonly rubric: ScorecardRubric;
  readonly weightBps: number;
  readonly displayOrder: number;
}

export interface RoleScorecardVersion {
  readonly id: string;
  readonly roleId: string;
  readonly version: number;
  readonly configurationHash: string;
  readonly metrics: readonly RoleScorecardMetric[];
}

/** Model output deliberately uses an array, never user-owned object keys. */
export interface ScorecardMetricModelResult {
  readonly configMetricId: string;
  readonly score: ScoreValue | null;
  readonly evidenceStatus: MetricEvidenceStatus;
  readonly rationale: string;
  readonly evidenceRefs: readonly string[];
}

export interface ScorecardMetricResult extends ScorecardMetricModelResult {
  readonly metric: RoleScorecardMetric;
}

export interface ScorecardAssessmentV2 {
  readonly schemaVersion: typeof SCORECARD_SCHEMA_VERSION;
  readonly scorecardVersionId: string;
  readonly revision: number;
  readonly status: ScorecardAssessmentStatus;
  readonly metricResults: readonly ScorecardMetricResult[];
  /**
   * The rubric scale this assessment was scored on. `4` since 0093; a `raw`
   * object persisted before that lacks the field and readers treat it as `5`.
   * (`weightedScore5` keeps its historical name; its range is 1..scoreScaleMax.)
   */
  readonly scoreScaleMax: ScoreScaleMax;
  readonly weightedScore5: number | null;
  readonly overallScore: number | null;
  readonly recommendation: 'advance' | 'hold' | 'reject' | 'human_review';
}

export type AssessmentReadModel =
  | { readonly schemaVersion: 1; readonly assessment: Assessment }
  | { readonly schemaVersion: typeof SCORECARD_SCHEMA_VERSION; readonly assessment: ScorecardAssessmentV2 };

export function isScoreValue(value: unknown): value is ScoreValue {
  return typeof value === 'number' && Number.isInteger(value) && value >= SCORE_MIN && value <= SCORE_MAX;
}

/** A metric score on a PERSISTED row's own scale (4 today, 5 for pre-0093 rows). */
export function isScoreOnScale(value: unknown, scaleMax: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= SCORE_MIN && value <= scaleMax;
}

export function isScoreScaleMax(value: unknown): value is ScoreScaleMax {
  return (SCORE_SCALE_MAX_VALUES as readonly number[]).includes(value as number);
}

/** Legacy rows retain their original payload and are never translated into invented v2 scores. */
export function asLegacyAssessment(assessment: Assessment): AssessmentReadModel {
  return { schemaVersion: 1, assessment };
}
