/**
 * Pure helpers behind the charts, kept out of the component files so each of
 * those exports components only (fast refresh), and so the truthfulness
 * rules can be asserted directly rather than through a canvas jsdom cannot
 * draw.
 */
import type { LineSeriesOption } from 'echarts';

export interface LineChartDatum {
  label: string;
  value: number;
}

/** One line of a multi-series chart. Labels are matched across series. */
export interface LineChartSeries {
  name: string;
  data: LineChartDatum[];
  /** An approved palette value; defaults to the categorical cycle. */
  color?: string;
}

/**
 * Every series' labels, in time order. Each series is already in order, so a
 * label new to the union is inserted straight after the label that precedes
 * it in its own series: a day only the second series has lands between its
 * neighbours, not at the end of the axis.
 */
export function unionLabels(series: LineChartSeries[]): string[] {
  const out: string[] = [];
  for (const s of series) {
    let cursor = -1;
    for (const d of s.data) {
      const at = out.indexOf(d.label);
      if (at === -1) {
        out.splice(cursor + 1, 0, d.label);
        cursor += 1;
      } else {
        cursor = at;
      }
    }
  }
  return out;
}

/**
 * The ECharts line series for `series`, on the union of their labels.
 *
 * Exported so the two truthfulness rules are asserted directly rather than
 * through a canvas that jsdom cannot draw: every line is straight
 * (`smooth: false`), and a day missing from a series is `null` (a gap),
 * never 0.
 */
export function buildLineSeries(
  series: LineChartSeries[],
  { discrete = false, colors }: { discrete?: boolean; colors: string[] },
): { labels: string[]; lines: LineSeriesOption[] } {
  const labels = unionLabels(series);
  const multi = series.length > 1;
  const dense = labels.length > 45;
  const lines: LineSeriesOption[] = series.map((s, index) => {
    const byLabel = new Map(s.data.map((d) => [d.label, d.value]));
    const color = s.color ?? colors[index % colors.length];
    return {
      type: 'line',
      name: s.name,
      // `null` = no observation that day: a gap, never a zero.
      data: labels.map((label) => byLabel.get(label) ?? null),
      smooth: false,
      connectNulls: false,
      symbol: 'circle',
      // At 5px plus a 1.5px border markers merge into a solid band once
      // points are closer than ~8px, which a 90-day half-width chart
      // reaches well before its end.
      symbolSize: dense ? 3 : 5,
      // Hiding markers is only safe when consecutive points are
      // consecutive periods; `discrete` says they may not be.
      showSymbol: discrete || labels.length <= 20,
      lineStyle: { width: 2, color },
      itemStyle: { color, borderColor: '#ffffff', borderWidth: 1.5 },
      // A wash under a single line reads as depth; under two it muddies
      // both, so multi-series charts draw lines only.
      areaStyle: multi
        ? undefined
        : {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(78, 107, 166, 0.2)' },
                { offset: 1, color: 'rgba(78, 107, 166, 0)' },
              ],
            },
          },
      emphasis: { focus: 'series' },
    };
  });
  return { labels, lines };
}

/** A share as a whole percent; a real but tiny share reads "<1%", never "0%". */
export function shareLabel(value: number, total: number): string {
  if (total <= 0) return '—';
  const pct = (value / total) * 100;
  if (value > 0 && pct < 0.5) return '<1%';
  return `${Math.round(pct)}%`;
}

