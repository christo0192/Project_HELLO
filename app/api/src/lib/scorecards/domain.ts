import { createHash } from 'node:crypto';
import {
  SCORECARD_MAX_EVIDENCE_REFS,
  SCORECARD_MAX_INSTRUCTION_LENGTH,
  SCORECARD_MAX_METRICS,
  SCORECARD_MAX_NAME_LENGTH,
  SCORECARD_MAX_RATIONALE_LENGTH,
  SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH,
  SCORECARD_WEIGHT_TOTAL_BPS,
  type MetricEvidenceStatus,
  type RoleScorecardMetric,
  type ScoreValue,
  type ScorecardMetricModelResult,
  type ScorecardRubric,
} from './contracts.js';

export class ScorecardValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScorecardValidationError';
  }
}

function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new ScorecardValidationError(`${field} must be text`);
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > max) {
    throw new ScorecardValidationError(`${field} must contain 1..${max} characters`);
  }
  return normalized;
}

export function validateRubric(value: unknown): ScorecardRubric {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ScorecardValidationError('rubric must be an object with levels 1..5');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== '1,2,3,4,5') {
    throw new ScorecardValidationError('rubric must have exactly levels 1,2,3,4,5');
  }
  return {
    1: boundedText(record['1'], 'rubric.1', SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH),
    2: boundedText(record['2'], 'rubric.2', SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH),
    3: boundedText(record['3'], 'rubric.3', SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH),
    4: boundedText(record['4'], 'rubric.4', SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH),
    5: boundedText(record['5'], 'rubric.5', SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH),
  };
}

export function validateRoleMetrics(metrics: readonly RoleScorecardMetric[]): readonly RoleScorecardMetric[] {
  if (metrics.length < 1 || metrics.length > SCORECARD_MAX_METRICS) {
    throw new ScorecardValidationError(`scorecard must contain 1..${SCORECARD_MAX_METRICS} metrics`);
  }
  const ids = new Set<string>();
  const keys = new Set<string>();
  const orders = new Set<number>();
  let total = 0;
  for (const metric of metrics) {
    if (!metric.id || ids.has(metric.id)) throw new ScorecardValidationError('metric IDs must be unique');
    if (!/^[a-z][a-z0-9_]{1,62}$/.test(metric.key) || keys.has(metric.key)) {
      throw new ScorecardValidationError('metric keys must be unique stable identifiers');
    }
    if (!Number.isInteger(metric.displayOrder) || metric.displayOrder < 0 || orders.has(metric.displayOrder)) {
      throw new ScorecardValidationError('metric display orders must be unique non-negative integers');
    }
    boundedText(metric.name, 'metric name', SCORECARD_MAX_NAME_LENGTH);
    boundedText(metric.instruction, 'metric instruction', SCORECARD_MAX_INSTRUCTION_LENGTH);
    validateRubric(metric.rubric);
    if (!Number.isInteger(metric.weightBps) || metric.weightBps < 1 || metric.weightBps > SCORECARD_WEIGHT_TOTAL_BPS) {
      throw new ScorecardValidationError('metric weight must be an integer between 1 and 10000 bps');
    }
    ids.add(metric.id); keys.add(metric.key); orders.add(metric.displayOrder); total += metric.weightBps;
  }
  if (total !== SCORECARD_WEIGHT_TOTAL_BPS) {
    throw new ScorecardValidationError(`metric weights must total ${SCORECARD_WEIGHT_TOTAL_BPS} bps`);
  }
  return [...metrics].sort((a, b) => a.displayOrder - b.displayOrder);
}

/** Canonical hash deliberately includes role-owned snapshots, not mutable library data. */
export function hashRoleScorecard(metrics: readonly RoleScorecardMetric[]): string {
  const canonical = validateRoleMetrics(metrics).map((metric) => ({
    id: metric.id,
    libraryMetricId: metric.libraryMetricId,
    key: metric.key,
    name: metric.name.trim().replace(/\s+/g, ' '),
    instruction: metric.instruction.trim().replace(/\s+/g, ' '),
    rubric: validateRubric(metric.rubric),
    weightBps: metric.weightBps,
    displayOrder: metric.displayOrder,
  }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Pin one metric at `newWeightBps`; redistribute the remaining bps over every
 * other metric proportionally. Largest-remainder rounding with display order
 * tie-breaking makes the result deterministic and exact.
 */
export function redistributeWeights(
  metrics: readonly RoleScorecardMetric[],
  editedMetricId: string,
  newWeightBps: number,
): readonly RoleScorecardMetric[] {
  const ordered = validateRoleMetrics(metrics);
  const edited = ordered.find((metric) => metric.id === editedMetricId);
  if (!edited) throw new ScorecardValidationError('edited metric is not in the scorecard');
  const others = ordered.filter((metric) => metric.id !== editedMetricId);
  if (!Number.isInteger(newWeightBps) || newWeightBps < 1 || newWeightBps > SCORECARD_WEIGHT_TOTAL_BPS - others.length) {
    throw new ScorecardValidationError('edited metric weight leaves no positive weight for another metric');
  }
  if (!others.length) return [{ ...edited, weightBps: SCORECARD_WEIGHT_TOTAL_BPS }];

  const remainder = SCORECARD_WEIGHT_TOTAL_BPS - newWeightBps;
  const oldOtherTotal = others.reduce((sum, metric) => sum + metric.weightBps, 0);
  const shares = others.map((metric) => {
    const numerator = oldOtherTotal > 0 ? remainder * metric.weightBps : remainder;
    const denominator = oldOtherTotal > 0 ? oldOtherTotal : others.length;
    const floor = Math.floor(numerator / denominator);
    return { metric, floor, fractional: numerator % denominator };
  });
  let unallocated = remainder - shares.reduce((sum, share) => sum + share.floor, 0);
  shares.sort((a, b) => b.fractional - a.fractional || a.metric.displayOrder - b.metric.displayOrder);
  const redistributed = new Map(shares.map((share) => [share.metric.id, share.floor]));
  for (const share of shares) {
    if (unallocated-- <= 0) break;
    redistributed.set(share.metric.id, (redistributed.get(share.metric.id) ?? 0) + 1);
  }
  return ordered.map((metric) => metric.id === editedMetricId
    ? { ...metric, weightBps: newWeightBps }
    : { ...metric, weightBps: redistributed.get(metric.id)! });
}

export interface ValidatedMetricResult extends ScorecardMetricModelResult {
  readonly score: ScoreValue | null;
  readonly evidenceStatus: MetricEvidenceStatus;
}

export function validateMetricResults(
  configuredMetrics: readonly RoleScorecardMetric[],
  results: readonly ScorecardMetricModelResult[],
): readonly ValidatedMetricResult[] {
  const configured = validateRoleMetrics(configuredMetrics);
  if (results.length !== configured.length) throw new ScorecardValidationError('model output must contain exactly one result per metric');
  const expected = new Set(configured.map((metric) => metric.id));
  const seen = new Set<string>();
  for (const result of results) {
    if (!expected.has(result.configMetricId) || seen.has(result.configMetricId)) {
      throw new ScorecardValidationError('model output contains an unknown or duplicate metric ID');
    }
    seen.add(result.configMetricId);
    if (result.evidenceStatus !== 'scored' && result.evidenceStatus !== 'insufficient_evidence') {
      throw new ScorecardValidationError('metric evidence status is invalid');
    }
    if (result.evidenceStatus === 'scored' && (!Number.isInteger(result.score) || result.score! < 1 || result.score! > 5)) {
      throw new ScorecardValidationError('scored metric must have an integer score from 1 to 5');
    }
    if (result.evidenceStatus === 'insufficient_evidence' && result.score !== null) {
      throw new ScorecardValidationError('insufficient-evidence metric must not receive an invented score');
    }
    boundedText(result.rationale, 'metric rationale', SCORECARD_MAX_RATIONALE_LENGTH);
    if (!Array.isArray(result.evidenceRefs) || result.evidenceRefs.length > SCORECARD_MAX_EVIDENCE_REFS || result.evidenceRefs.some((ref) => typeof ref !== 'string' || ref.length > 100)) {
      throw new ScorecardValidationError('metric evidence references are invalid');
    }
  }
  return configured.map((metric) => results.find((result) => result.configMetricId === metric.id)!);
}

export function calculateWeightedScore(
  configuredMetrics: readonly RoleScorecardMetric[],
  results: readonly ScorecardMetricModelResult[],
): number | null {
  const configured = validateRoleMetrics(configuredMetrics);
  const validated = validateMetricResults(configured, results);
  if (validated.some((result) => result.score === null)) return null;
  const byId = new Map(validated.map((result) => [result.configMetricId, result]));
  const score = configured.reduce((sum, metric) => sum + metric.weightBps * byId.get(metric.id)!.score!, 0) / SCORECARD_WEIGHT_TOTAL_BPS;
  return Math.round(score * 10_000) / 10_000;
}

export function weightedScoreToOverall(score: number | null): number | null {
  if (score === null) return null;
  if (!Number.isFinite(score) || score < 1 || score > 5) throw new ScorecardValidationError('weighted score must be between 1 and 5');
  return Math.round(((score - 1) / 4) * 100);
}

export function recommendationForOverall(overall: number | null): 'advance' | 'hold' | 'reject' | 'human_review' {
  if (overall === null) return 'human_review';
  if (overall >= 65) return 'advance';
  if (overall >= 45) return 'hold';
  return 'reject';
}
