/**
 * The what-if line in "Check before deciding": what a provisional score would read once its unscored
 * metrics are scored.
 *
 * The arithmetic is HELLO's own, so these figures are the ones the scorer would produce. It mirrors
 * `calculateWeightedScore`, `weightedScoreToOverall` and `recommendationForOverall` in
 * app/api/src/lib/scorecards/domain.ts and the two must stay in step: the same weighted mean, rounded
 * to four places first, then the same projection onto 0-100 and the same cut-offs. Text only, computed
 * from the row's own weights and scores. Nothing here is a new score, and nothing is stored.
 *
 * Legal approved the form of the line on 2026-11-05: "Once Closing is scored it would read X to Y; at
 * Fair, Z (Borderline)". "Closing" and "Fair" were the mock's data. The metric and the rubric word come
 * from the row, so the word beside the figure is one the rubric beside it really uses.
 */

import { scoreLabel } from '../types';
import type { ScoreScaleMax, ScorecardMetricDisplay } from '../types';
import { RECOMMENDATION_LABELS } from './recommendation-labels';

/** domain.ts `recommendationForOverall`: at or above this the AI recommends Select. */
export const SELECT_CUTOFF = 65;
/** The same: at or above this it recommends Borderline, below it Reject. */
export const BORDERLINE_CUTOFF = 45;

const SCORE_MIN = 1;

export interface WeightedScore {
  weightBps: number;
  score: number;
}

/** domain.ts `calculateWeightedScore` then `weightedScoreToOverall`, for a list with a score each. */
export function overallFromScores(scores: readonly WeightedScore[], scaleMax: ScoreScaleMax): number {
  const weightTotal = scores.reduce((sum, s) => sum + s.weightBps, 0);
  const weightedSum = scores.reduce((sum, s) => sum + s.weightBps * s.score, 0);
  const weighted = Math.round((weightedSum / weightTotal) * 10_000) / 10_000;
  return Math.round(((weighted - SCORE_MIN) / (scaleMax - SCORE_MIN)) * 100);
}

/** domain.ts `recommendationForOverall`, for a figure that exists. */
export function recommendationForOverall(overall: number): 'advance' | 'hold' | 'reject' {
  if (overall >= SELECT_CUTOFF) return 'advance';
  if (overall >= BORDERLINE_CUTOFF) return 'hold';
  return 'reject';
}

export interface WhatIf {
  /** The unscored metrics, in rubric order. */
  names: string[];
  low: number;
  high: number;
  /** The rubric's own word for the middle reading. */
  levelWord: string;
  atLevel: number;
  /** The recommendation `atLevel` would earn, in words. */
  verdict: string;
}

/** "Average" on either scale: the second of four levels, the third of five. */
const middleLevel = (scaleMax: ScoreScaleMax): number => (scaleMax === 5 ? 3 : 2);

/**
 * What the score would read, or null when there is nothing honest to say: every metric is scored, no
 * metric is (there is no reading to compare), or a weight is unknown. Every unscored metric moves
 * together, so the range is the whole of what is still open.
 */
export function scoreWhatIf({
  metrics,
  scoreScaleMax,
}: {
  metrics: readonly ScorecardMetricDisplay[];
  scoreScaleMax: ScoreScaleMax;
}): WhatIf | null {
  const unscored = metrics.filter((m) => m.score === null);
  if (unscored.length === 0 || unscored.length === metrics.length) return null;
  if (metrics.some((m) => typeof m.weightBps !== 'number' || m.weightBps <= 0)) return null;

  const readingAt = (level: number) =>
    overallFromScores(metrics.map((m) => ({ weightBps: m.weightBps!, score: m.score ?? level })), scoreScaleMax);

  const level = middleLevel(scoreScaleMax);
  const atLevel = readingAt(level);
  return {
    names: unscored.map((m) => m.name),
    low: readingAt(SCORE_MIN),
    high: readingAt(scoreScaleMax),
    levelWord: scoreLabel(level, scoreScaleMax),
    atLevel,
    verdict: RECOMMENDATION_LABELS[recommendationForOverall(atLevel)],
  };
}

function listed(names: readonly string[]): string {
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The line, in the form Legal approved. */
export function whatIfLine({ names, low, high, levelWord, atLevel, verdict }: WhatIf): string {
  const waiting = `${listed(names)} ${names.length === 1 ? 'is' : 'are'}`;
  return `Once ${waiting} scored it would read ${low} to ${high}; at ${levelWord}, ${atLevel} (${verdict})`;
}
