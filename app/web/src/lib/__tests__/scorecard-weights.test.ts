/**
 * scorecard-weights — the client mirror of the server's weight redistribution.
 *
 * These pin the two invariants the role scorecard slider depends on: the output
 * ALWAYS totals 10000 bps (100%), and the largest-remainder distribution is the
 * exact deterministic result the server's domain.redistributeWeights produces.
 */

import { describe, it, expect } from 'vitest';
import {
  SCORECARD_WEIGHT_TOTAL_BPS,
  bpsToPercent,
  evenWeights,
  formatWeightPercent,
  redistributeWeights,
  totalWeightBps,
  weightsAreComplete,
  type WeightedMetric,
} from '../scorecard-weights';

function m(id: string, weightBps: number, displayOrder: number): WeightedMetric {
  return { id, weightBps, displayOrder };
}

describe('redistributeWeights', () => {
  it('pins the edited metric and spreads the remainder, totalling exactly 100%', () => {
    const set = [m('a', 3334, 0), m('b', 3333, 1), m('c', 3333, 2)];
    const result = redistributeWeights(set, 'a', 5000);
    expect(totalWeightBps(result)).toBe(SCORECARD_WEIGHT_TOTAL_BPS);
    expect(result.find((x) => x.id === 'a')!.weightBps).toBe(5000);
    expect(result.find((x) => x.id === 'b')!.weightBps).toBe(2500);
    expect(result.find((x) => x.id === 'c')!.weightBps).toBe(2500);
  });

  it('matches the server largest-remainder result on a fractional split', () => {
    // b/c cannot divide evenly: floors 3499/3500 leave 1 unallocated, which
    // goes to the larger fractional (c), tie-broken by display order.
    const set = [m('a', 3333, 0), m('b', 3333, 1), m('c', 3334, 2)];
    const result = redistributeWeights(set, 'a', 3000);
    expect(result.find((x) => x.id === 'a')!.weightBps).toBe(3000);
    expect(result.find((x) => x.id === 'b')!.weightBps).toBe(3499);
    expect(result.find((x) => x.id === 'c')!.weightBps).toBe(3501);
    expect(totalWeightBps(result)).toBe(SCORECARD_WEIGHT_TOTAL_BPS);
  });

  it('proportionally follows the current weights', () => {
    const set = [m('a', 5000, 0), m('b', 3000, 1), m('c', 2000, 2)];
    const result = redistributeWeights(set, 'a', 4000);
    expect(result.find((x) => x.id === 'b')!.weightBps).toBe(3600);
    expect(result.find((x) => x.id === 'c')!.weightBps).toBe(2400);
    expect(totalWeightBps(result)).toBe(SCORECARD_WEIGHT_TOTAL_BPS);
  });

  it('always totals 100% across a sweep of pin values', () => {
    const set = [m('a', 2500, 0), m('b', 2500, 1), m('c', 2500, 2), m('d', 2500, 3)];
    for (let pct = 1; pct <= 99; pct++) {
      const result = redistributeWeights(set, 'b', pct * 100);
      expect(totalWeightBps(result)).toBe(SCORECARD_WEIGHT_TOTAL_BPS);
    }
  });

  it('clamps a pin that would starve the other metrics, still totalling 100%', () => {
    const set = [m('a', 3334, 0), m('b', 3333, 1), m('c', 3333, 2)];
    // 100% would leave 0 for the two others — clamp so each keeps ≥1 bps.
    const result = redistributeWeights(set, 'a', SCORECARD_WEIGHT_TOTAL_BPS);
    expect(totalWeightBps(result)).toBe(SCORECARD_WEIGHT_TOTAL_BPS);
    expect(result.find((x) => x.id === 'a')!.weightBps).toBe(SCORECARD_WEIGHT_TOTAL_BPS - 2);
    for (const item of result) expect(item.weightBps).toBeGreaterThanOrEqual(1);
  });

  it('gives the whole weight to a single metric', () => {
    const result = redistributeWeights([m('a', 4000, 0)], 'a', 4000);
    expect(result).toHaveLength(1);
    expect(result[0].weightBps).toBe(SCORECARD_WEIGHT_TOTAL_BPS);
  });

  it('returns the set unchanged when the edited id is unknown', () => {
    const set = [m('a', 6000, 0), m('b', 4000, 1)];
    expect(redistributeWeights(set, 'missing', 5000)).toEqual(set);
  });
});

describe('evenWeights', () => {
  it('distributes 10000 bps as evenly as possible, totalling 100%', () => {
    for (let n = 1; n <= 7; n++) {
      const set = Array.from({ length: n }, (_, i) => m(`x${i}`, 0, i));
      const result = evenWeights(set);
      expect(totalWeightBps(result)).toBe(SCORECARD_WEIGHT_TOTAL_BPS);
      for (const item of result) expect(item.weightBps).toBeGreaterThanOrEqual(1);
      // Even split within 1 bps of each other.
      const weights = result.map((x) => x.weightBps);
      expect(Math.max(...weights) - Math.min(...weights)).toBeLessThanOrEqual(1);
    }
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
