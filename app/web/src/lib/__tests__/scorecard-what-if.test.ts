/**
 * The what-if line. These figures sit beside an automated hiring recommendation, so they must be
 * the figures the scorer would produce: the same weighted mean, the same rounding, the same
 * cut-offs. `WORKED` is the table app/api/src/__tests__/scorecard-domain.test.ts runs through the
 * scorer itself (`calculateWeightedScore`, `weightedScoreToOverall`, `recommendationForOverall`), so a
 * change on either side fails here. The rest is worked by hand from those functions.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BORDERLINE_CUTOFF,
  SELECT_CUTOFF,
  overallFromScores,
  recommendationForOverall,
  scoreWhatIf,
  whatIfLine,
} from '../scorecard-what-if';
import type { ScoreScaleMax, ScorecardMetricDisplay } from '../../types';

const WORKED = JSON.parse(
  readFileSync(resolve(process.cwd(), '../api/src/__tests__/fixtures/scorecard-worked-scores.json'), 'utf8'),
) as {
  cutoffs: { select: number; borderline: number };
  cases: Array<{
    name: string;
    scaleMax: ScoreScaleMax;
    metrics: Array<[number, number | null]>;
    overall: number;
    recommendation: string;
  }>;
};

const metric = (name: string, weightBps: number | null, score: ScorecardMetricDisplay['score']): ScorecardMetricDisplay => ({
  id: name,
  name,
  score,
  evidenceStatus: score === null ? 'insufficient_evidence' : 'scored',
  rationale: '',
  evidenceRefs: [],
  weightBps,
});

// 25% at 4, 20% at 3, 20% at 3, 20% at 2, 15% unscored.
const FOUR_OF_FIVE = [
  metric('Needs discovery', 2500, 4),
  metric('Communication', 2000, 3),
  metric('Objections', 2000, 3),
  metric('Programme', 2000, 2),
  metric('Ownership', 1500, null),
];

describe('overallFromScores', () => {
  it('is the weighted mean over the metrics given, on the row scale, as a percentage', () => {
    // (2500*4 + 2000*3 + 2000*3 + 2000*2) / 8500 = 3.0588; (3.0588 - 1) / 3 = 68.6
    expect(overallFromScores(FOUR_OF_FIVE.slice(0, 4).map((m) => ({ weightBps: m.weightBps!, score: m.score! })), 4)).toBe(69);
  });

  it('reads a five-level row on its own scale', () => {
    expect(overallFromScores([{ weightBps: 10000, score: 3 }], 5)).toBe(50);
  });

  it.each(WORKED.cases)("reads the scorer's own worked figure: $name", ({ scaleMax, metrics, overall, recommendation }) => {
    const scored = metrics.flatMap(([weightBps, score]) => (score === null ? [] : [{ weightBps, score }]));
    expect(overallFromScores(scored, scaleMax)).toBe(overall);
    expect(recommendationForOverall(overall)).toBe(recommendation);
  });
});

describe('recommendationForOverall', () => {
  it('uses the cut-offs of 45 and 65', () => {
    expect([BORDERLINE_CUTOFF, SELECT_CUTOFF]).toEqual([WORKED.cutoffs.borderline, WORKED.cutoffs.select]);
    expect([BORDERLINE_CUTOFF, SELECT_CUTOFF]).toEqual([45, 65]);
    expect(recommendationForOverall(65)).toBe('advance');
    expect(recommendationForOverall(64)).toBe('hold');
    expect(recommendationForOverall(45)).toBe('hold');
    expect(recommendationForOverall(44)).toBe('reject');
  });
});

describe('scoreWhatIf', () => {
  it('works out the lowest, the highest and the middle reading once the metric is scored', () => {
    // At 1: 2.75 -> 58. At 4: 3.2 -> 73. At 2: 2.9 -> 63, which is Borderline.
    expect(scoreWhatIf({ metrics: FOUR_OF_FIVE, scoreScaleMax: 4 })).toEqual({
      names: ['Ownership'],
      low: 58,
      high: 73,
      levelWord: 'Average',
      atLevel: 63,
      verdict: 'Borderline',
    });
  });

  it('gives the verdict the middle reading would earn, not the current one', () => {
    const what = scoreWhatIf({ metrics: [metric('A', 7000, 4), metric('B', 3000, null)], scoreScaleMax: 4 })!;
    // 1 -> (28000 + 3000) / 10000 = 3.1 -> 70; 4 -> 4 -> 100; 2 -> 3.4 -> 80.
    expect(what).toMatchObject({ low: 70, high: 100, atLevel: 80, verdict: 'Select' });
  });

  it('a metric the scorer left out counts at its full weight here, and every missing one moves together', () => {
    const what = scoreWhatIf({
      metrics: [metric('A', 5000, 3), metric('B', 2500, null), metric('C', 2500, null)],
      scoreScaleMax: 4,
    })!;
    expect(what.names).toEqual(['B', 'C']);
    // 1 -> 2 -> 33; 4 -> 3.5 -> 83; 2 -> 2.5 -> 50.
    expect(what).toMatchObject({ low: 33, high: 83, atLevel: 50, verdict: 'Borderline' });
  });

  it('reads a five-level row on its own scale and its own middle word', () => {
    const what = scoreWhatIf({ metrics: [metric('A', 5000, 4), metric('B', 5000, null)], scoreScaleMax: 5 })!;
    // 1 -> 2.5 -> 38; 5 -> 4.5 -> 88; 3 -> 3.5 -> 63.
    expect(what).toMatchObject({ low: 38, high: 88, atLevel: 63, levelWord: 'Average' });
  });

  it('shows nothing when every metric is scored', () => {
    expect(scoreWhatIf({ metrics: [metric('A', 10000, 3)], scoreScaleMax: 4 })).toBeNull();
  });

  it('shows nothing when no metric is scored: there is no reading to compare', () => {
    expect(scoreWhatIf({ metrics: [metric('A', 10000, null)], scoreScaleMax: 4 })).toBeNull();
  });

  it('shows nothing when a weight is unknown, rather than guess one', () => {
    expect(scoreWhatIf({ metrics: [metric('A', null, 3), metric('B', null, null)], scoreScaleMax: 4 })).toBeNull();
  });
});

describe('whatIfLine', () => {
  it('reads in the form Legal approved', () => {
    expect(
      whatIfLine({ names: ['Closing'], low: 49, high: 67, levelWord: 'Average', atLevel: 55, verdict: 'Borderline' }),
    ).toBe('Once Closing is scored it would read 49 to 67; at Average, 55 (Borderline)');
  });

  it('keeps the grammar when more than one metric is waiting', () => {
    expect(
      whatIfLine({ names: ['Closing', 'Ownership', 'Rapport'], low: 10, high: 90, levelWord: 'Average', atLevel: 50, verdict: 'Borderline' }),
    ).toBe('Once Closing, Ownership and Rapport are scored it would read 10 to 90; at Average, 50 (Borderline)');
  });
});
