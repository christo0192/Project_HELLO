/**
 * scorecard-weights — the reporting helpers the typed-weight editor is built on.
 *
 * Weights are typed per metric, so the editor never rebalances a set. That
 * makes these the load-bearing pieces: the total, the SIGNED distance from
 * 100% (which is what the running total states), and the positivity check that
 * catches the one set the server rejects despite totalling exactly 100%.
 *
 * `redistributeWeights` used to be mirrored here so the weight SLIDER could
 * re-balance instantly; it went with the slider. Its equality-with-the-server
 * cases still live in app/api/src/__tests__/scorecard-domain.test.ts, which is
 * now the only implementation under test.
 */

import { describe, it, expect } from 'vitest';
import {
  SCORECARD_WEIGHT_TOTAL_BPS,
  bpsToPercent,
  everyWeightIsPositive,
  formatWeightPercent,
  totalWeightBps,
  weightDeltaBps,
  weightsAreComplete,
  type WeightedMetric,
} from '../scorecard-weights';

function m(id: string, weightBps: number, displayOrder: number): WeightedMetric {
  return { id, weightBps, displayOrder };
}

describe('weightDeltaBps', () => {
  it('is 0 on a complete set', () => {
    expect(weightDeltaBps([m('a', 6000, 0), m('b', 4000, 1)])).toBe(0);
  });

  it('is POSITIVE when over and NEGATIVE when short', () => {
    // The sign is the whole contract: the editor renders "over" vs "short"
    // off it, so a swapped subtraction would state the opposite of the truth
    // while every total-based assertion stayed green.
    expect(weightDeltaBps([m('a', 6000, 0), m('b', 5000, 1)])).toBe(1000);
    expect(weightDeltaBps([m('a', 6000, 0), m('b', 3000, 1)])).toBe(-1000);
  });

  it('reports the empty set as a full 100% short, not as complete', () => {
    expect(weightDeltaBps([])).toBe(-SCORECARD_WEIGHT_TOTAL_BPS);
  });
});

describe('everyWeightIsPositive', () => {
  it('is false when a metric sits at 0 even though the set totals 100%', () => {
    // The set the server rejects despite a perfect total — reported separately
    // so the editor can name the real problem instead of "must total 100%".
    const set = [m('a', 10000, 0), m('b', 0, 1)];
    expect(weightsAreComplete(set)).toBe(true);
    expect(everyWeightIsPositive(set)).toBe(false);
  });

  it('accepts the smallest weight the server allows (1 bps)', () => {
    expect(everyWeightIsPositive([m('a', 9999, 0), m('b', 1, 1)])).toBe(true);
  });

  it('rejects a negative weight', () => {
    expect(everyWeightIsPositive([m('a', 10100, 0), m('b', -100, 1)])).toBe(false);
  });

  it('is vacuously true on an empty set — completeness is what gates Save there', () => {
    expect(everyWeightIsPositive([])).toBe(true);
    expect(weightsAreComplete([])).toBe(false);
  });
});

describe('percent helpers', () => {
  it('converts and formats bps to a compact percent', () => {
    expect(bpsToPercent(2500)).toBe(25);
    expect(formatWeightPercent(2500)).toBe('25%');
    expect(formatWeightPercent(10000)).toBe('100%');
    expect(formatWeightPercent(1250)).toBe('12.5%');
    expect(formatWeightPercent(3333)).toBe('33.33%');
  });

  it('reports completeness', () => {
    expect(weightsAreComplete([m('a', 6000, 0), m('b', 4000, 1)])).toBe(true);
    expect(weightsAreComplete([m('a', 6000, 0), m('b', 3000, 1)])).toBe(false);
  });
});
