/**
 * Pure helpers behind the charts, kept out of the component files so each of
 * those exports components only (fast refresh), and so the truthfulness
 * rules can be asserted directly rather than through a canvas jsdom cannot
 * draw.
 */
import type { LineSeriesOption } from 'echarts';
import type { ChartFamily, ChartPalette } from './theme';

export interface LineChartDatum {
  label: string;
  value: number;
  /**
   * The calendar day the point stands for, `YYYY-MM-DD`. A multi-series
   * chart builds its axis from this, not from `label`: "3 Sep" carries no
   * year and does not sort, so two series' days can only be merged in the
   * right order by the date they were labelled from.
   */
  date?: string;
}

/** One line of a multi-series chart. Labels are matched across series. */
export interface LineChartSeries {
  name: string;
  data: LineChartDatum[];
  /**
   * What this line means, when it means something: a verdict or an outcome passes
   * its family, so its colour never depends on its place in the cycle.
   */
  family?: ChartFamily;
  /** A token value from `chartPalette`; defaults to the family, then the cycle. */
  color?: string;
}

/** The colour series `index` draws in. The line and its legend key both read this. */
export function seriesColor(
  series: LineChartSeries,
  index: number,
  { colors, families }: Pick<ChartPalette, 'colors'> & Partial<Pick<ChartPalette, 'families'>>,
): string {
  return series.color ?? (series.family && families?.[series.family]) ?? colors[index % colors.length];
}

/**
 * Every series' labels, in time order.
 *
 * With a `date` on every point, the union is sorted by it. Merging by order
 * alone cannot be right in general: `[1 Sep, 3 Sep]` and `[2 Sep, 3 Sep]`
 * say only that 1 and 2 both come before 3, not which comes first, and the
 * old merge answered "2 Sep, 1 Sep, 3 Sep".
 *
 * Without dates (a caller that has only labels), each series is still taken
 * to be in order: a new label goes straight after the label before it in its
 * own series, or, when it LEADS its series, straight before the next of its
 * series' labels the union already has. That places the case above
 * correctly; a label no other series shares goes at the end.
 */
export function unionLabels(series: LineChartSeries[]): string[] {
  const points = series.flatMap((s) => s.data);
  if (points.length > 0 && points.every((d) => typeof d.date === 'string' && d.date !== '')) {
    const dateOf = new Map<string, string>();
    for (const d of points) if (!dateOf.has(d.label)) dateOf.set(d.label, d.date as string);
    // ISO days sort as strings. Stable, so two labels on one day keep the
    // order they first appeared in.
    return [...dateOf.keys()].sort((a, b) => {
      const x = dateOf.get(a) as string;
      const y = dateOf.get(b) as string;
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }

  const out: string[] = [];
  for (const s of series) {
    let cursor = -1;
    s.data.forEach((d, i) => {
      const at = out.indexOf(d.label);
      if (at !== -1) {
        cursor = at;
        return;
      }
      let insertAt = cursor + 1;
      if (cursor === -1) {
        // Nothing of this series placed yet: anchor on what follows instead.
        const next = s.data.slice(i + 1).find((later) => out.includes(later.label));
        insertAt = next ? out.indexOf(next.label) : out.length;
      }
      out.splice(insertAt, 0, d.label);
      cursor = insertAt;
    });
  }
  return out;
}

/** Marker per series, in cycle order. */
const MARKERS = ['circle', 'rect', 'triangle', 'diamond'] as const;

/**
 * Dash per series, in cycle order; `null` is a solid line. Colour is never the only
 * signal, so two lines that mean opposite things also differ in their stroke. A
 * marker cannot settle that alone, because markers are hidden past 20 points; a
 * dash holds at any density.
 */
const DASHES: ReadonlyArray<readonly number[] | null> = [null, [6, 4], [2, 3], [8, 3, 2, 3]];

export interface SeriesStroke {
  marker: (typeof MARKERS)[number];
  dash: readonly number[] | null;
}

/** How series `index` is drawn. The line and its legend key both read this. */
export function seriesStroke(index: number): SeriesStroke {
  return { marker: MARKERS[index % MARKERS.length], dash: DASHES[index % DASHES.length] };
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
  {
    discrete = false,
    colors,
    families,
    surface = 'transparent',
  }: { discrete?: boolean; colors: string[]; families?: ChartPalette['families']; surface?: string },
): { labels: string[]; lines: LineSeriesOption[] } {
  const labels = unionLabels(series);
  const dense = labels.length > 45;
  const lines: LineSeriesOption[] = series.map((s, index) => {
    const byLabel = new Map(s.data.map((d) => [d.label, d.value]));
    const color = seriesColor(s, index, { colors, families });
    const { marker, dash } = seriesStroke(index);
    return {
      type: 'line',
      name: s.name,
      // `null` = no observation that day: a gap, never a zero.
      data: labels.map((label) => byLabel.get(label) ?? null),
      smooth: false,
      connectNulls: false,
      // A shape and a dash tell lines apart without relying on the hue.
      symbol: marker,
      // At 5px plus a 1.5px border markers merge into a solid band once
      // points are closer than ~8px, which a 90-day half-width chart
      // reaches well before its end.
      symbolSize: dense ? 3 : 5,
      // Hiding markers is only safe when consecutive points are
      // consecutive periods; `discrete` says they may not be.
      showSymbol: discrete || labels.length <= 20,
      lineStyle: { width: 2, color, type: dash ? [...dash] : 'solid' },
      itemStyle: { color, borderColor: surface, borderWidth: 1.5 },
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
