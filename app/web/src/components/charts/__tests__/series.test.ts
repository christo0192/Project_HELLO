/**
 * `unionLabels`: the x-axis of a multi-series chart. A day in the wrong place
 * draws a line segment backwards in time, which reads as a real swing.
 */
import { describe, expect, it } from 'vitest';
import { buildLineSeries, unionLabels } from '../series';
import type { LineChartSeries } from '../series';

const day = (label: string, date?: string, value = 1) => ({ label, value, ...(date ? { date } : {}) });

describe('unionLabels', () => {
  it('puts a day only the later series has, and that LEADS it, in date order', () => {
    // The adversarial-review case: the old merge inserted "2 Sep" at index 0.
    const series: LineChartSeries[] = [
      { name: 'Qualified', data: [day('1 Sep', '2026-09-01'), day('3 Sep', '2026-09-03')] },
      { name: 'Disqualified', data: [day('2 Sep', '2026-09-02'), day('3 Sep', '2026-09-03')] },
    ];
    expect(unionLabels(series)).toEqual(['1 Sep', '2 Sep', '3 Sep']);
  });

  it('merges on the date, so a range across New Year stays in order', () => {
    // "30 Dec" < "1 Jan" as labels is unknowable without the year; the date
    // decides. Neither series' order alone says where "31 Dec" goes.
    const series: LineChartSeries[] = [
      { name: 'A', data: [day('30 Dec', '2025-12-30'), day('2 Jan', '2026-01-02')] },
      { name: 'B', data: [day('31 Dec', '2025-12-31'), day('1 Jan', '2026-01-01')] },
    ];
    expect(unionLabels(series)).toEqual(['30 Dec', '31 Dec', '1 Jan', '2 Jan']);
  });

  it('without dates, still places a leading day before the next day it shares', () => {
    const series: LineChartSeries[] = [
      { name: 'Qualified', data: [day('1 Sep'), day('3 Sep')] },
      { name: 'Disqualified', data: [day('2 Sep'), day('3 Sep')] },
    ];
    expect(unionLabels(series)).toEqual(['1 Sep', '2 Sep', '3 Sep']);
  });

  it('without dates, keeps each series in order and appends what no one shares', () => {
    expect(
      unionLabels([
        { name: 'A', data: [day('1 Sep'), day('3 Sep')] },
        { name: 'B', data: [day('1 Sep'), day('2 Sep'), day('3 Sep'), day('4 Sep')] },
      ]),
    ).toEqual(['1 Sep', '2 Sep', '3 Sep', '4 Sep']);
    expect(
      unionLabels([
        { name: 'A', data: [day('1 Sep'), day('2 Sep')] },
        { name: 'B', data: [day('3 Sep'), day('4 Sep')] },
      ]),
    ).toEqual(['1 Sep', '2 Sep', '3 Sep', '4 Sep']);
  });

  it("maps each series' values onto the merged axis, a missing day as a gap", () => {
    const { labels, lines } = buildLineSeries(
      [
        { name: 'Qualified', data: [day('1 Sep', '2026-09-01', 40), day('3 Sep', '2026-09-03', 20)] },
        { name: 'Disqualified', data: [day('2 Sep', '2026-09-02', 30), day('3 Sep', '2026-09-03', 5)] },
      ],
      { colors: ['#398AA2', '#B45A72'] },
    );
    expect(labels).toEqual(['1 Sep', '2 Sep', '3 Sep']);
    expect(lines[0].data).toEqual([40, null, 20]);
    expect(lines[1].data).toEqual([null, 30, 5]);
  });
});
