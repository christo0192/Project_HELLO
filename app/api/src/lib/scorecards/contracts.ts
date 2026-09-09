import type { Assessment } from '../types.js';

export const SCORECARD_SCHEMA_VERSION = 2 as const;
export const SCORECARD_WEIGHT_TOTAL_BPS = 10_000 as const;
export const SCORECARD_MAX_METRICS = 20 as const;
export const SCORECARD_MAX_NAME_LENGTH = 100 as const;
export const SCORECARD_MAX_INSTRUCTION_LENGTH = 1_000 as const;
export const SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH = 500 as const;
export const SCORECARD_MAX_RATIONALE_LENGTH = 1_000 as const;
export const SCORECARD_MAX_EVIDENCE_REFS = 10 as const;

export const SCORE_LABELS = {
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
  readonly weightedScore5: number | null;
  readonly overallScore: number | null;
  readonly recommendation: 'advance' | 'hold' | 'reject' | 'human_review';
}

export type AssessmentReadModel =
  | { readonly schemaVersion: 1; readonly assessment: Assessment }
  | { readonly schemaVersion: typeof SCORECARD_SCHEMA_VERSION; readonly assessment: ScorecardAssessmentV2 };

export function isScoreValue(value: unknown): value is ScoreValue {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5;
}

/** Legacy rows retain their original payload and are never translated into invented v2 scores. */
export function asLegacyAssessment(assessment: Assessment): AssessmentReadModel {
  return { schemaVersion: 1, assessment };
}
