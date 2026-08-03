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
 * Skill scorecard radar chart. Pairs the canvas with an sr-only data table
 * (no Canvas keyboard claims — see EChart).
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
        axisName: { color: palette.subtext, fontSize: 11 },
        axisLine: { lineStyle: { color: palette.splitLine } },
        splitLine: { lineStyle: { color: palette.splitLine } },
        splitArea: {
          areaStyle: { color: ['transparent', `${palette.splitLine}33`] },
        },
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
          lineStyle: { width: 2 },
          areaStyle: { opacity: 0.12 },
        },
      ],
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
          headers={['Indicator', `Score (out of ${max})`]}
          rows={data.map((d) => ({ cells: [d.indicator, d.value] }))}
        />
      )}
    </figure>
  );
}
