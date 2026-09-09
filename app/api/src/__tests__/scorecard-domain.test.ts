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

  it('reserves a positive weight for every metric under an adversarial double-pin (FIX 3, no 0 bps)', () => {
    // start [2500,2500,2500,2500] → pin metric-0=9900 → then pin metric-1=9800.
    // The old proportional split floored metric-3 to 0 bps (invalid weightBps<1,
    // the save 400s and the slider sticks). The reserve-1 rule keeps every OTHER
    // metric >= 1 while still totalling 10000 with the pin exact.
    const start = metrics([2500, 2500, 2500, 2500]);
    const afterFirst = redistributeWeights(start, 'metric-0', 9900);
    expect(afterFirst.map((m) => m.weightBps)).toEqual([9900, 34, 33, 33]);

    const afterSecond = redistributeWeights(afterFirst, 'metric-1', 9800);
    expect(afterSecond.map((m) => m.weightBps)).toEqual([197, 9800, 2, 1]);
    expect(afterSecond.reduce((sum, m) => sum + m.weightBps, 0)).toBe(10_000);
    expect(afterSecond.find((m) => m.id === 'metric-1')!.weightBps).toBe(9800);
    expect(afterSecond.every((m) => m.weightBps >= 1)).toBe(true);
  });

  it('produces the byte-identical result the client mirror asserts (shared cases)', () => {
    // These SAME cases + expected literals are asserted in the web client test
    // app/web/src/lib/__tests__/scorecard-weights.test.ts; editing one side of
    // the redistribution math without the other breaks this equality.
    const cases: Array<{ weights: number[]; editIndex: number; newWeight: number; expected: number[] }> = [
      { weights: [5000, 3000, 2000], editIndex: 0, newWeight: 4000, expected: [4000, 3600, 2400] },
      { weights: [2500, 2500, 2500, 2500], editIndex: 0, newWeight: 9900, expected: [9900, 34, 33, 33] },
      { weights: [3334, 3333, 3333], editIndex: 0, newWeight: 1, expected: [1, 5000, 4999] },
      { weights: [3334, 3333, 3333], editIndex: 0, newWeight: 5000, expected: [5000, 2500, 2500] },
      { weights: [3333, 3333, 3334], editIndex: 0, newWeight: 3000, expected: [3000, 3499, 3501] },
    ];
    for (const { weights, editIndex, newWeight, expected } of cases) {
      const out = redistributeWeights(metrics(weights), `metric-${editIndex}`, newWeight);
      expect(out.map((m) => m.weightBps), `[${weights}] pin#${editIndex}=${newWeight}`).toEqual(expected);
      expect(out.reduce((sum, m) => sum + m.weightBps, 0)).toBe(10_000);
    }
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
