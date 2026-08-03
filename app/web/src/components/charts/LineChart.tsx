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

export interface LineChartDatum {
  label: string;
  value: number;
}

export interface LineChartProps {
  title: string;
  description?: string;
  data: LineChartDatum[];
  unit?: string;
  isLoading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  className?: string;
  height?: number;
  /** Show an inside dataZoom when there are more points than this. */
  zoomThreshold?: number;
  /** Overridden to 'svg' in tests (jsdom has no canvas). */
  renderer?: 'canvas' | 'svg';
}

/**
 * Sessions-over-time line chart with an inside dataZoom for dense series.
 * Always pairs the canvas with an sr-only data table (no Canvas keyboard
 * claims — see EChart).
 */
export function LineChart({
  title,
  description,
  data,
  unit = 'sessions',
  isLoading = false,
  error = null,
  onRetry,
  className,
  height = 260,
  zoomThreshold = 14,
  renderer = 'canvas',
}: LineChartProps) {
  const { theme } = useTheme();
  const reduced = useReducedMotion();
  const { palette, base } = chartTheme(theme, reduced);

  let body: ReactNode;
  if (isLoading) {
    body = <ChartSkeleton />;
  } else if (error) {
    body = <ChartError message={error} onRetry={onRetry} />;
  } else if (data.length === 0) {
    body = (
      <ChartEmpty title="No sessions yet" hint="Sessions will appear here once screening starts." />
    );
  } else {
    const option: EChartsOption = {
      ...base,
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: data.map((d) => d.label),
        axisLine: { lineStyle: { color: palette.axisLine } },
        axisLabel: { color: palette.subtext },
      },
      yAxis: {
        type: 'value',
        axisLine: { show: false },
        axisLabel: { color: palette.subtext },
        splitLine: { lineStyle: { color: palette.splitLine } },
      },
      grid: {
        left: 8,
        right: 8,
        top: 16,
        bottom: 8,
        // echarts 6: containLabel is deprecated; outerBoundsMode is equivalent.
        outerBoundsMode: 'same',
        outerBoundsContain: 'axisLabel',
      },
      tooltip: { trigger: 'axis' },
      series: [
        {
          type: 'line',
          name: title,
          data: data.map((d) => d.value),
          smooth: 0.3,
          symbol: 'circle',
          symbolSize: 6,
          showSymbol: data.length <= 20,
          lineStyle: { width: 2 },
          areaStyle: { opacity: 0.08 },
          emphasis: { focus: 'series' },
        },
      ],
      dataZoom:
        data.length > zoomThreshold
          ? [{ type: 'inside', start: 0, end: 100 }]
          : undefined,
    };
    body = (
      <ChartReveal epoch={data.length} className="h-full">
        <EChart option={option} ariaLabel={title} height={height} renderer={renderer} />
      </ChartReveal>
    );
  }

  return (
    <figure className={cx('h-full', className)}>
      <figcaption className="sr-only">
        {title}
        {description ? ` — ${description}` : ''}
      </figcaption>
      {body}
      {!isLoading && !error && data.length > 0 && (
        <ChartDataTable
          caption={`${title} data`}
          headers={['Date', unit.charAt(0).toUpperCase() + unit.slice(1)]}
          rows={data.map((d) => ({ cells: [d.label, d.value] }))}
        />
      )}
    </figure>
  );
}
