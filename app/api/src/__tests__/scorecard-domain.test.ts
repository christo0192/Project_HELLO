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
  validateRubric,
  weightedScoreToOverall,
} from '../lib/scorecards/domain.js';
import type { RoleScorecardMetric, ScorecardMetricModelResult } from '../lib/scorecards/contracts.js';

const rubric = { 1: 'Poor', 2: 'Average', 3: 'Good', 4: 'Excellent' } as const;
function metrics(weights = [5000, 3000, 2000]): RoleScorecardMetric[] {
  return weights.map((weightBps, index) => ({
    id: `metric-${index}`, libraryMetricId: `library-${index}`, key: `metric_${index + 1}`,
    name: `Metric ${index + 1}`, instruction: 'Use direct transcript evidence.', rubric,
    weightBps, displayOrder: index,
  }));
}
function results(scores: Array<1 | 2 | 3 | 4 | null>): ScorecardMetricModelResult[] {
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

  it('accepts EXACTLY the four rubric levels — a 5-key or 3-key rubric is rejected', () => {
    // 0093 closed the rubric at four levels. The retired five-level shape is the
    // one a stale caller (or an un-migrated library row) would send, so it must
    // be refused as loudly as a short rubric — never silently truncated.
    const fiveLevel = { ...rubric, 5: 'Excellent (retired level)' } as unknown as typeof rubric;
    const threeLevel = { 1: 'Poor', 2: 'Average', 3: 'Good' } as unknown as typeof rubric;
    expect(() => validateRubric(fiveLevel)).toThrow(/exactly levels 1,2,3,4/);
    expect(() => validateRubric(threeLevel)).toThrow(/exactly levels 1,2,3,4/);
    expect(() => validateRubric(null)).toThrow(/levels 1\.\.4/);
    expect(() => validateRubric([rubric[1], rubric[2], rubric[3], rubric[4]])).toThrow(/levels 1\.\.4/);
    // …and the four-level rubric round-trips with numeric keys.
    expect(validateRubric({ ...rubric })).toEqual(rubric);
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
    // (5000*4 + 3000*3 + 2000*1) / 10000 = 3.1 on the four-point rubric.
    expect(calculateWeightedScore(metrics(), results([4, 3, 1]))).toBe(3.1);
    expect(weightedScoreToOverall(1)).toBe(0);
    expect(weightedScoreToOverall(2.5)).toBe(50); // the midpoint of 1..4
    expect(weightedScoreToOverall(3.1)).toBe(70);
    expect(weightedScoreToOverall(4)).toBe(100);
    expect(recommendationForOverall(65)).toBe('advance');
    expect(recommendationForOverall(45)).toBe('hold');
    expect(recommendationForOverall(null)).toBe('human_review');
  });

  it('projects a pre-0093 five-point row and a 0093 four-point row onto the SAME 0–100 meaning', () => {
    // The whole point of carrying `score_scale_max` on the row: the midpoint of
    // each scale must land on the same overall, so a historical assessment and a
    // new one are comparable on the candidate card and in the funnel rollups.
    expect(weightedScoreToOverall(3, 5)).toBe(50);
    expect(weightedScoreToOverall(2.5, 4)).toBe(50);
    // Endpoints agree too.
    expect(weightedScoreToOverall(1, 5)).toBe(0);
    expect(weightedScoreToOverall(1, 4)).toBe(0);
    expect(weightedScoreToOverall(5, 5)).toBe(100);
    expect(weightedScoreToOverall(4, 4)).toBe(100);
    // The default scale is the CURRENT one, so an untagged call is four-point.
    expect(weightedScoreToOverall(4)).toBe(weightedScoreToOverall(4, 4));
    // A null weighted score stays null on either scale — never an invented 0.
    expect(weightedScoreToOverall(null, 5)).toBeNull();
    expect(weightedScoreToOverall(null)).toBeNull();
  });

  it('fails closed on an unknown rubric scale and on a score outside that scale', () => {
    // Only 4 and 5 are admissible scales; anything else would silently
    // mis-project a persisted score, so it throws instead.
    expect(() => weightedScoreToOverall(3, 6)).toThrow(/unknown rubric scale/);
    expect(() => weightedScoreToOverall(3, 10)).toThrow(/unknown rubric scale/);
    // 5 is in range for a pre-0093 row and OUT of range on the four-point scale.
    expect(weightedScoreToOverall(5, 5)).toBe(100);
    expect(() => weightedScoreToOverall(5)).toThrow(/weighted score must be between 1 and 4/);
    expect(() => weightedScoreToOverall(0.5)).toThrow(/weighted score must be between 1 and 4/);
    expect(() => weightedScoreToOverall(5.5, 5)).toThrow(/weighted score must be between 1 and 5/);
  });

  it('PARTIAL SCORING: renormalizes over the scored metrics; null ONLY when none scored', () => {
    // The production failure (assessment e333af5d): one un-evidenced metric must
    // NOT void the whole card. With weights [5000, 3000, 2000], scoring only
    // metric-0 (4) and metric-2 (1) renormalizes over {5000, 2000}:
    //   (5000*4 + 2000*1) / (5000+2000) = 22000/7000 = 3.1429 (4dp).
    expect(calculateWeightedScore(metrics(), results([4, null, 1]))).toBe(3.1429);
    // The e333af5d shape itself: 5 equal metrics, 3 scored @3, 2 insufficient →
    // renormalizes to exactly 3.0, the recovered weighted value.
    expect(calculateWeightedScore(metrics([2000, 2000, 2000, 2000, 2000]), results([3, null, null, 3, 3]))).toBe(3);
    // That weighted 3.0 is projected on the RUBRIC SCALE OF THE ROW. The 0091
    // recovery ran on the five-point rubric, where 3/5 → 50 → 'hold'. The same
    // shape scored today is 3/4 ('Good') → 67 → 'advance'. Both are correct for
    // their own scale — which is exactly why the scale is persisted per row.
    expect(weightedScoreToOverall(3, 5)).toBe(50);
    expect(recommendationForOverall(50)).toBe('hold');
    expect(weightedScoreToOverall(3)).toBe(67);
    expect(recommendationForOverall(67)).toBe('advance');
    // A single scored metric still yields that metric's score (renormalized to 1).
    expect(calculateWeightedScore(metrics(), results([null, 4, null]))).toBe(4);
    // Null ONLY when NOT ONE metric was scored — a genuinely unscoreable screening.
    expect(calculateWeightedScore(metrics(), results([null, null, null]))).toBeNull();
    // Full coverage is unchanged: weightTotal == 10000, so identical to before.
    expect(calculateWeightedScore(metrics(), results([4, 3, 1]))).toBe(3.1);
  });

  it('rejects missing, extra, duplicate, fractional, off-scale, and invented scores', () => {
    // A FULL-LENGTH result list with only element 0 corrupted, so each case trips
    // the guard it names rather than the (earlier) count check.
    const corruptFirst = (patch: Partial<ScorecardMetricModelResult>): ScorecardMetricModelResult[] =>
      [{ ...results([4])[0], ...patch }, ...results([4, 3, 2]).slice(1)];

    expect(() => validateMetricResults(metrics(), results([4, 3]))).toThrow(ScorecardValidationError);
    expect(() => validateMetricResults(metrics(), [...results([4, 3, 2]), { ...results([4])[0], configMetricId: 'unknown' }])).toThrow(ScorecardValidationError);
    expect(() => validateMetricResults(metrics(), corruptFirst({ configMetricId: 'metric-1' }))).toThrow(ScorecardValidationError);
    expect(() => validateMetricResults(metrics(), corruptFirst({ score: 2.5 as 3 })))
      .toThrow(/scored metric must have an integer score from 1 to 4/);
    // A 5 is what a stale prompt/model would still emit; on the four-point rubric
    // it is off-scale and must be refused rather than clamped down to 4.
    expect(() => validateMetricResults(metrics(), corruptFirst({ score: 5 as 3 })))
      .toThrow(/scored metric must have an integer score from 1 to 4/);
    // insufficient_evidence must never carry a score — the fabrication guard.
    expect(() => validateMetricResults(metrics(), corruptFirst({ evidenceStatus: 'insufficient_evidence' })))
      .toThrow(/must not receive an invented score/);
  });
});
