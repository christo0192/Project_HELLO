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

export interface GaugeChartProps {
  title: string;
  description?: string;
  value: number;
  max?: number;
  unit?: string;
  sublabel?: string;
  isLoading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  className?: string;
  height?: number;
  /** Overridden to 'svg' in tests (jsdom has no canvas). */
  renderer?: 'canvas' | 'svg';
}

/**
 * Quota-utilization gauge. The arc turns amber only when utilization crosses
 * the 85% threshold (restrained, semantic warning use). Pairs the canvas
 * with an sr-only data table (no Canvas keyboard claims — see EChart).
 */
export function GaugeChart({
  title,
  description,
  value,
  max = 100,
  unit = '%',
  sublabel,
  isLoading = false,
  error = null,
  onRetry,
  className,
  height = 240,
  renderer = 'canvas',
}: GaugeChartProps) {
  const { theme } = useTheme();
  const reduced = useReducedMotion();
  const { palette, base } = chartTheme(theme, reduced);
  const ratio = max > 0 ? value / max : 0;
  const arcColor = ratio >= 0.85 ? palette.colors[3] : palette.colors[0];

  let body: React.ReactNode;
  if (isLoading) {
    body = <ChartSkeleton />;
  } else if (error) {
    body = <ChartError message={error} onRetry={onRetry} />;
  } else if (max <= 0) {
    body = (
      <ChartEmpty title="Quota disabled" hint="Utilization is unavailable while the quota policy is disabled." />
    );
  } else {
    const option: EChartsOption = {
      ...base,
      series: [
        {
          type: 'gauge',
          min: 0,
          max,
          startAngle: 210,
          endAngle: -30,
          progress: { show: true, width: 10, itemStyle: { color: arcColor } },
          axisLine: { lineStyle: { width: 10, color: [[1, palette.splitLine]] } },
          pointer: { show: false },
          axisTick: { show: false },
          splitLine: { show: false },
          axisLabel: { show: false },
          anchor: { show: false },
          title: {
            show: sublabel != null,
            offsetCenter: [0, '32%'],
            color: palette.subtext,
            fontSize: 12,
          },
          detail: {
            valueAnimation: !reduced,
            offsetCenter: [0, '0%'],
            formatter: (current: number) => `${Math.round(current)}${unit}`,
            color: palette.text,
            fontSize: 24,
            fontWeight: 700,
          },
          data: [{ value, name: sublabel }],
        },
      ],
    };
    body = (
      <ChartReveal epoch={Math.round(value)} className="h-full">
        <EChart option={option} ariaLabel={`${title}: ${Math.round(value)}${unit} of ${max}`} height={height} renderer={renderer} />
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
      {!isLoading && !error && max > 0 && (
        <ChartDataTable
          caption={`${title} data`}
          headers={['Metric', 'Value', 'Limit']}
          rows={[{ cells: [sublabel ?? title, `${value}${unit}`, `${max}${unit}`] }]}
        />
      )}
    </figure>
  );
}
