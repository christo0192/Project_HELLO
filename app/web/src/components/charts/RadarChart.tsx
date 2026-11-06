import type { ReactNode } from 'react';
import type { EChartsOption } from 'echarts';
import { cx } from '../design/cx';
import { ChartSkeleton } from '../design/Skeleton';
import { ChartDataTable } from './accessibility';
import { EChart } from './EChart';
import { ChartEmpty, ChartError } from './states';
import { chartTheme } from './theme';

export interface RadarChartDatum {
  indicator: string;
  value: number;
}

export interface RadarChartProps {
  title: string;
  description?: string;
  data: RadarChartDatum[];
  /** Indicator scale max (default 100). */
  max?: number;
  seriesName?: string;
  isLoading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  className?: string;
  height?: number;
  /** Overridden to 'svg' in tests (jsdom has no canvas). */
  renderer?: 'canvas' | 'svg';
}

/**
 * Skill scorecard radar chart. One shape spans several ratings, so no one family
 * fits it and the series is ink: a place in the cycle would mean nothing. Pairs the
 * canvas with an sr-only data table (no Canvas keyboard claims — see EChart).
 */
export function RadarChart({
  title,
  description,
  data,
  max = 100,
  seriesName,
  isLoading = false,
  error = null,
  onRetry,
  className,
  height = 260,
  renderer = 'canvas',
}: RadarChartProps) {
  const { palette, base } = chartTheme();

  let body: ReactNode;
  if (isLoading) {
    body = <ChartSkeleton />;
  } else if (error) {
    body = <ChartError message={error} onRetry={onRetry} />;
  } else if (data.length === 0) {
    body = (
      <ChartEmpty title="No assessment yet" hint="Skill scores will appear once an assessment is recorded." />
    );
  } else {
    const option: EChartsOption = {
      ...base,
      tooltip: { trigger: 'item' },
      radar: {
        indicator: data.map((d) => ({ name: d.indicator, max })),
        radius: '62%',
        splitNumber: 4,
        axisName: { color: palette.subtext, fontSize: 12 },
        axisLine: { lineStyle: { color: palette.splitLine } },
        splitLine: { lineStyle: { color: palette.splitLine } },
        splitArea: { show: false },
      },
      series: [
        {
          type: 'radar',
          data: [
            {
              value: data.map((d) => d.value),
              name: seriesName ?? title,
            },
          ],
          symbol: 'circle',
          symbolSize: 5,
          lineStyle: { width: 2, color: palette.text },
          itemStyle: { color: palette.text },
          areaStyle: { opacity: 0.12, color: palette.text },
        },
      ],
    };
    body = (
      <EChart option={option} ariaLabel={title} height={height} renderer={renderer} />
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
          headers={['Indicator', `Score (out of ${max})`]}
          rows={data.map((d) => ({ cells: [d.indicator, d.value] }))}
        />
      )}
    </figure>
  );
}
