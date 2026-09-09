import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ScorecardValidationError,
  calculateWeightedScore,
  hashRoleScorecard,
  recommendationForOverall,
  redistributeWeights,
  validateMetricResults,
  validateRoleMetrics,
  weightedScoreToOverall,
} from '../lib/scorecards/domain.js';
import type { RoleScorecardMetric, ScorecardMetricModelResult } from '../lib/scorecards/contracts.js';

const rubric = { 1: 'Poor', 2: 'Below average', 3: 'Average', 4: 'Good', 5: 'Excellent' } as const;
function metrics(weights = [5000, 3000, 2000]): RoleScorecardMetric[] {
  return weights.map((weightBps, index) => ({
    id: `metric-${index}`, libraryMetricId: `library-${index}`, key: `metric_${index + 1}`,
    name: `Metric ${index + 1}`, instruction: 'Use direct transcript evidence.', rubric,
    weightBps, displayOrder: index,
  }));
}
function results(scores: Array<1 | 2 | 3 | 4 | 5 | null>): ScorecardMetricModelResult[] {
  return scores.map((score, index) => ({
    configMetricId: `metric-${index}`, score,
    evidenceStatus: score === null ? 'insufficient_evidence' : 'scored',
    rationale: 'Evidence is bounded and grounded in the transcript.', evidenceRefs: ['turn:1'],
  }));
}

describe('scorecard domain', () => {
  it('requires exact positive weights and immutable metric shape', () => {
    expect(() => validateRoleMetrics(metrics([5000, 4999, 0]))).toThrow(ScorecardValidationError);
    expect(() => validateRoleMetrics([{ ...metrics()[0], rubric: { ...rubric, 6: 'Injected' } as unknown as typeof rubric }])).toThrow(ScorecardValidationError);
    expect(validateRoleMetrics(metrics())).toHaveLength(3);
  });

  it('redistributes proportionally with deterministic largest-remainder rounding', () => {
    const next = redistributeWeights(metrics([5000, 3000, 2000]), 'metric-0', 4000);
    expect(next.map((metric) => metric.weightBps)).toEqual([4000, 3600, 2400]);
    expect(next.reduce((sum, metric) => sum + metric.weightBps, 0)).toBe(10_000);
    expect(redistributeWeights(metrics([3334, 3333, 3333]), 'metric-0', 1)
      .map((metric) => metric.weightBps)).toEqual([1, 5000, 4999]);
  });

  it('always preserves exact total, pin, and positive weights', () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 9998 }),
      (editedWeight) => {
        const next = redistributeWeights(metrics(), 'metric-0', editedWeight);
        expect(next[0].weightBps).toBe(editedWeight);
        expect(next.reduce((sum, metric) => sum + metric.weightBps, 0)).toBe(10_000);
        expect(next.every((metric) => Number.isInteger(metric.weightBps) && metric.weightBps > 0)).toBe(true);
      },
    ));
  });

  it('hashes the canonical display order and snapshot fields', () => {
    const original = metrics();
    expect(hashRoleScorecard(original)).toBe(hashRoleScorecard([...original].reverse()));
    expect(hashRoleScorecard(original)).not.toBe(hashRoleScorecard([{ ...original[0], instruction: 'Different.' }, ...original.slice(1)]));
  });

  it('computes server-owned scores and never invents missing evidence', () => {
    expect(calculateWeightedScore(metrics(), results([5, 3, 1]))).toBe(3.6);
    expect(weightedScoreToOverall(1)).toBe(0);
    expect(weightedScoreToOverall(3)).toBe(50);
    expect(weightedScoreToOverall(5)).toBe(100);
    expect(recommendationForOverall(65)).toBe('advance');
    expect(recommendationForOverall(45)).toBe('hold');
    expect(recommendationForOverall(null)).toBe('human_review');
    expect(calculateWeightedScore(metrics(), results([5, null, 1]))).toBeNull();
  });

  it('rejects missing, extra, duplicate, fractional, and invented scores', () => {
    expect(() => validateMetricResults(metrics(), results([5, 4]))).toThrow(ScorecardValidationError);
    expect(() => validateMetricResults(metrics(), [...results([5, 4, 3]), { ...results([5])[0], configMetricId: 'unknown' }])).toThrow(ScorecardValidationError);
    expect(() => validateMetricResults(metrics(), [{ ...results([5])[0], score: 2.5 as 3 }, ...results([4, 3]).slice(1)])).toThrow(ScorecardValidationError);
    expect(() => validateMetricResults(metrics(), [{ ...results([null])[0], score: 3 as 3 }, ...results([4, 3]).slice(1)])).toThrow(ScorecardValidationError);
  });
});
