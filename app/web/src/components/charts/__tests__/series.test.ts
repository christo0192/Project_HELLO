/**
 * `unionLabels`: the x-axis of a multi-series chart. A day in the wrong place
 * draws a line segment backwards in time, which reads as a real swing.
 */
import { describe, expect, it } from 'vitest';
import { buildLineSeries, seriesColor, unionLabels } from '../series';
import type { LineChartSeries } from '../series';

const day = (label: string, date?: string, value = 1) => ({ label, value, ...(date ? { date } : {}) });

describe('a series colour', () => {
  const palette = {
    colors: ['#000001', '#000002', '#000003'],
    families: { moving: '#00000a', ready: '#00000b', unresolved: '#00000c', closed: '#00000d' },
  };
  const line = (extra: Partial<LineChartSeries> = {}): LineChartSeries => ({ name: 'S', data: [day('1 Sep')], ...extra });

  it('takes its family, whatever its place in the cycle', () => {
    expect(seriesColor(line({ family: 'closed' }), 0, palette)).toBe('#00000d');
    expect(seriesColor(line({ family: 'closed' }), 2, palette)).toBe('#00000d');
  });

  it('falls back to its place in the cycle only when it means nothing', () => {
    expect(seriesColor(line(), 0, palette)).toBe('#000001');
    expect(seriesColor(line(), 4, palette)).toBe('#000002');
  });

  it('draws the line and its marker in the family, and keeps its dash and marker shape', () => {
    const { lines } = buildLineSeries(
      [
        { name: 'Qualified', data: [day('1 Sep')], family: 'ready' },
        { name: 'Disqualified', data: [day('1 Sep')], family: 'closed' },
      ],
      palette,
    );
    expect(lines[0].lineStyle?.color).toBe('#00000b');
    expect(lines[0].itemStyle?.color).toBe('#00000b');
    expect(lines[0].lineStyle?.type).toBe('solid');
    expect(lines[0].symbol).toBe('circle');
    expect(lines[1].lineStyle?.color).toBe('#00000d');
    expect(lines[1].lineStyle?.type).toEqual([6, 4]);
    expect(lines[1].symbol).toBe('rect');
  });
});

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
