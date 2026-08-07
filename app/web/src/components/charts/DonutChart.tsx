import type { EChartsInstance } from 'echarts-for-react/lib/types';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { EChartsOption } from 'echarts';
import { useReducedMotion } from '../../lib/motion';
import { useTheme } from '../../lib/theme';
import { cx } from '../design/cx';
import { ChartSkeleton } from '../design/Skeleton';
import { ChartDataTable } from './accessibility';
import { EChart } from './EChart';
import { LegendHoverProvider } from './legend-hover';
import { ChartReveal } from './reveal';
import { ChartEmpty, ChartError } from './states';
import { chartTheme } from './theme';

export interface DonutChartDatum {
  label: string;
  value: number;
  /**
   * Optional drill-down target. When present the legend entry becomes a real
   * router link and the matching slice becomes clickable, so the segment
   * navigates to a filtered destination (accessible via the legend link).
   */
  href?: string;
}

export interface DonutChartProps {
  title: string;
  description?: string;
  data: DonutChartDatum[];
  isLoading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  className?: string;
  height?: number;
  /** Overridden to 'svg' in tests (jsdom has no canvas). */
  renderer?: 'canvas' | 'svg';
  /**
   * Called with the datum index when a slice is clicked (mouse convenience;
   * keyboard/AT users use the accessible legend links instead).
   */
  onSegmentSelect?: (index: number) => void;
}

/**
 * Candidate-status donut with a native HTML legend. Legend hover dims the
 * other slices via ECharts highlight/downplay — the bklit-ui legend
 * hover-dim pattern adapted to ECharts (MIT — THIRD_PARTY_NOTICES.md).
 * Pairs the canvas with an sr-only data table (no Canvas keyboard claims).
 */
export function DonutChart({
  title,
  description,
  data,
  isLoading = false,
  error = null,
  onRetry,
  className,
  height = 260,
  renderer = 'canvas',
  onSegmentSelect,
}: DonutChartProps) {
  const { theme } = useTheme();
  const reduced = useReducedMotion();
  const { palette, base } = chartTheme(theme, reduced);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const instanceRef = useRef<EChartsInstance | null>(null);
  const onSegmentSelectRef = useRef(onSegmentSelect);
  onSegmentSelectRef.current = onSegmentSelect;

  // Legend hover-dim: dim all slices, then highlight the hovered one.
  useEffect(() => {
    const instance = instanceRef.current;
    if (!instance) return;
    instance.dispatchAction({ type: 'downplay' });
    if (hoveredIndex !== null) {
      instance.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex: hoveredIndex });
    }
  }, [hoveredIndex]);

  const total = data.reduce((sum, d) => sum + d.value, 0);

  let body: React.ReactNode;
  if (isLoading) {
    body = <ChartSkeleton />;
  } else if (error) {
    body = <ChartError message={error} onRetry={onRetry} />;
  } else if (data.length === 0) {
    body = (
      <ChartEmpty title="No candidates" hint="Candidate status distribution will appear here." />
    );
  } else {
    const option: EChartsOption = {
      ...base,
      tooltip: { trigger: 'item' },
      legend: { show: false },
      series: [
        {
          type: 'pie',
          radius: ['60%', '82%'],
          center: ['50%', '46%'],
          avoidLabelOverlap: true,
          itemStyle: { borderColor: palette.tooltipBg, borderWidth: 2, borderRadius: 4 },
          label: { show: false },
          emphasis: { scaleSize: 4 },
          data: data.map((d) => ({ name: d.label, value: d.value })),
        },
      ],
      graphic: [
        {
          type: 'text',
          left: 'center',
          top: '41%',
          style: {
            text: String(total),
            align: 'center',
            fill: palette.text,
            fontSize: 22,
            fontWeight: 700,
          },
        },
        {
          type: 'text',
          left: 'center',
          top: '54%',
          style: {
            text: 'total',
            align: 'center',
            fill: palette.subtext,
            fontSize: 11,
          },
        },
      ],
    };
    body = (
      <div className="flex h-full flex-col">
        <ChartReveal epoch={data.length} className="min-h-0 flex-1">
          <EChart
            option={option}
            ariaLabel={`${title}: ${total} total`}
            height={height}
            renderer={renderer}
            onChartReady={(instance) => {
              instanceRef.current = instance;
              instance.off('click');
              instance.on('click', (params: { dataIndex?: number }) => {
                if (typeof params.dataIndex === 'number') {
                  onSegmentSelectRef.current?.(params.dataIndex);
                }
              });
            }}
          />
        </ChartReveal>
        <LegendHoverProvider hoveredIndex={hoveredIndex} onHoverChange={setHoveredIndex}>
          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
            {data.map((d, index) => {
              const swatch = (
                <span
                  aria-hidden="true"
                  className="h-2 w-2 shrink-0 rounded-sm"
                  style={{ backgroundColor: palette.colors[index % palette.colors.length] }}
                />
              );
              const hoverProps = {
                onMouseEnter: () => setHoveredIndex(index),
                onMouseLeave: () => setHoveredIndex(null),
                onFocus: () => setHoveredIndex(index),
                onBlur: () => setHoveredIndex(null),
              };
              const itemClass =
                'flex items-center gap-1.5 rounded px-1 py-0.5 text-xs text-ink-secondary transition-colors hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';
              return (
                <li key={d.label}>
                  {d.href ? (
                    <Link
                      to={d.href}
                      {...hoverProps}
                      className={itemClass}
                      aria-label={`${d.label}: ${d.value}. View these candidates.`}
                    >
                      {swatch}
                      <span>{d.label}</span>
                      <span className="tabular-nums text-ink-tertiary">{d.value}</span>
                    </Link>
                  ) : (
                    <button
                      type="button"
                      {...hoverProps}
                      aria-pressed={hoveredIndex === index}
                      className={itemClass}
                    >
                      {swatch}
                      <span>{d.label}</span>
                      <span className="tabular-nums text-ink-tertiary">{d.value}</span>
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </LegendHoverProvider>
      </div>
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
          headers={['Status', 'Count']}
          rows={data.map((d) => ({ cells: [d.label, d.value] }))}
        />
      )}
    </figure>
  );
}
