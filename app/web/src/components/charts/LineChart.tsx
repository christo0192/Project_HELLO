import type { ReactNode } from 'react';
import type { EChartsOption } from 'echarts';
import { useReducedMotion } from '../../lib/motion';
import { useTheme } from '../../lib/theme';
import { cx } from '../design/cx';
import { ChartSkeleton } from '../design/Skeleton';
import { ChartDataTable } from './accessibility';
import { EChart } from './EChart';
import { ChartReveal } from './reveal';
import { ChartEmpty, ChartError } from './states';
import { chartTheme } from './theme';
import { buildLineSeries } from './series';
import type { LineChartDatum, LineChartSeries } from './series';

export type { LineChartDatum, LineChartSeries } from './series';

export interface LineChartProps {
  title: string;
  description?: string;
  /** The single series. Ignored when `series` is given. */
  data?: LineChartDatum[];
  /**
   * Several series on one axis (e.g. qualified and disqualified rates over
   * the same days). A day missing from one series is a GAP in that line,
   * never a zero.
   */
  series?: LineChartSeries[];
  unit?: string;
  isLoading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  className?: string;
  height?: number;
  /** Show an inside dataZoom when there are more points than this. */
  zoomThreshold?: number;
  /**
   * Draw a marker on every point, however dense the series.
   *
   * For a series whose x-axis has had days REMOVED (a rate that is undefined
   * on days with no denominator), a symbol-less line turns "20% in June, 60%
   * in September, nothing in between" into an apparently unbroken climb.
   * Markers restore the "these are discrete observations" reading that the
   * spliced axis destroys.
   */
  discrete?: boolean;
  /** Empty-state heading. Defaults to the sessions wording. */
  emptyTitle?: string;
  /** Empty-state body. Defaults to the sessions wording. */
  emptyHint?: string;
  /** Overridden to 'svg' in tests (jsdom has no canvas). */
  renderer?: 'canvas' | 'svg';
}

/**
 * Line chart for counts and rates over days, with an inside dataZoom for
 * dense series. Always pairs the canvas with an sr-only data table (no
 * canvas keyboard claims, see EChart).
 *
 * STRAIGHT SEGMENTS, ALWAYS. A spline (`smooth`) invents values between the
 * points it passes through: the dashboard's "candidates added" curve dipped
 * below 1 between two days that each had exactly 1, and Mission Control's
 * session curve swung under zero. A count of people has no value between
 * two days, and a rate has no value on a day that was dropped. A straight
 * segment only claims "this changed to that", which is all the data says,
 * and it cannot overshoot either endpoint.
 */
export function LineChart({
  title,
  description,
  data = [],
  series: seriesProp,
  unit = 'sessions',
  isLoading = false,
  error = null,
  onRetry,
  className,
  height = 260,
  zoomThreshold = 14,
  discrete = false,
  emptyTitle = 'No sessions yet',
  emptyHint = 'Sessions will appear here once screening starts.',
  renderer = 'canvas',
}: LineChartProps) {
  const { theme } = useTheme();
  const reduced = useReducedMotion();
  const { palette, base } = chartTheme(theme, reduced);

  const series: LineChartSeries[] = seriesProp ?? [{ name: title, data }];
  const multi = series.length > 1;
  const { labels, lines } = buildLineSeries(series, { discrete, colors: palette.colors });
  const isPercent = unit === '%';
  const formatValue = (v: number | null | undefined) =>
    v == null ? 'No data' : isPercent ? `${v}%` : v.toLocaleString();

  let body: ReactNode;
  if (isLoading) {
    body = <ChartSkeleton />;
  } else if (error) {
    body = <ChartError message={error} onRetry={onRetry} />;
  } else if (labels.length === 0) {
    body = <ChartEmpty title={emptyTitle} hint={emptyHint} />;
  } else {
    const option: EChartsOption = {
      ...base,
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: labels,
        axisLine: { show: false },
        axisTick: { show: false },
        // `hideOverlap` drops labels cleanly rather than at a fixed interval:
        // a discrete series is read by its dates, so the ones it keeps must
        // be legible.
        axisLabel: { color: palette.subtext, margin: 12, hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        axisLine: { show: false },
        axisLabel: {
          color: palette.subtext,
          formatter: isPercent ? '{value}%' : undefined,
        },
        splitLine: { lineStyle: { color: palette.splitLine } },
        minInterval: 1,
        min: 0,
        // A rate is out of 100. Letting the axis stop at the data's max made
        // a flat 30% look like a chart-filling swing.
        max: isPercent ? 100 : undefined,
      },
      grid: {
        left: 8,
        right: 12,
        top: 16,
        bottom: 8,
        // echarts 6: containLabel is deprecated; outerBoundsMode is equivalent.
        outerBoundsMode: 'same',
        outerBoundsContain: 'axisLabel',
      },
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v) => formatValue(typeof v === 'number' ? v : null),
      },
      series: lines,
      dataZoom:
        labels.length > zoomThreshold ? [{ type: 'inside', start: 0, end: 100 }] : undefined,
    };
    // Block layout, not a flex column: the chart measures its container's
    // width when the window resizes, and a flex item with no content width
    // of its own collapsed to a few pixels during a full-page capture.
    body = (
      <>
        {multi && (
          <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1" aria-hidden="true">
            {series.map((s, index) => (
              <li key={s.name} className="flex items-center gap-1.5 text-xs text-ink-secondary">
                <span
                  className="h-0.5 w-3 rounded-full"
                  style={{ backgroundColor: s.color ?? palette.colors[index % palette.colors.length] }}
                />
                {s.name}
              </li>
            ))}
          </ul>
        )}
        <ChartReveal epoch={labels.length}>
          <EChart option={option} ariaLabel={title} height={height} renderer={renderer} />
        </ChartReveal>
      </>
    );
  }

  const valueHeader = unit === '%' ? 'Percent' : unit.charAt(0).toUpperCase() + unit.slice(1);
  return (
    <figure className={cx('h-full', className)}>
      <figcaption className="sr-only">
        {title}
        {description ? `. ${description}` : ''}
      </figcaption>
      {body}
      {!isLoading && !error && labels.length > 0 && (
        <ChartDataTable
          caption={`${title} data`}
          headers={['Date', ...(multi ? series.map((s) => s.name) : [valueHeader])]}
          rows={labels.map((label) => ({
            cells: [
              label,
              ...series.map((s) => {
                const hit = s.data.find((d) => d.label === label);
                return hit ? (isPercent ? `${hit.value}%` : hit.value) : 'No data';
              }),
            ],
          }))}
        />
      )}
    </figure>
  );
}
