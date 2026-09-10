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
