import ReactEChartsCore from 'echarts-for-react/lib/core';
import type { EChartsInstance } from 'echarts-for-react/lib/types';
import { useMemo } from 'react';
import type { EChartsOption } from 'echarts';
import { useReducedMotion } from '../../lib/motion';
import { useTheme } from '../../lib/theme';
import { cx } from '../design/cx';
import { echarts } from './echarts';
import { chartTheme } from './theme';

export interface EChartProps {
  option: EChartsOption;
  /** Accessible summary of the visualization (paired with an sr-only table). */
  ariaLabel: string;
  className?: string;
  height?: number | string;
  /** Overridden to 'svg' in tests (jsdom has no canvas). */
  renderer?: 'canvas' | 'svg';
  onChartReady?: (instance: EChartsInstance) => void;
}

/**
 * Merges the theme/reduced-motion base option with the caller's option.
 * Tooltip is merged shallowly so component-level triggers (axis/item) keep
 * the themed background/border from `chartTheme`.
 */
function mergeThemedOption(base: EChartsOption, option: EChartsOption): EChartsOption {
  const merged: Record<string, unknown> = { ...base, ...option };
  if (
    base.tooltip &&
    option.tooltip &&
    typeof base.tooltip === 'object' &&
    typeof option.tooltip === 'object'
  ) {
    merged.tooltip = { ...base.tooltip, ...option.tooltip };
  }
  return merged as EChartsOption;
}

/**
 * Shared ECharts binding. Canvas rendering is intentionally NOT
 * keyboard-accessible; do not attach tabIndex or interactive roles to it.
 * The adjacent sr-only data table is the authoritative AT source.
 */
export function EChart({
  option,
  ariaLabel,
  className,
  height = 260,
  renderer = 'canvas',
  onChartReady,
}: EChartProps) {
  const reducedMotion = useReducedMotion();
  const { theme } = useTheme();
  const themed = useMemo(() => {
    const { base } = chartTheme(theme, reducedMotion);
    return mergeThemedOption(base, option);
  }, [option, theme, reducedMotion]);

  return (
    <div role="img" aria-label={ariaLabel} className={cx('w-full', className)} style={{ height }}>
      <div aria-hidden="true" className="h-full w-full">
        <ReactEChartsCore
          echarts={echarts}
          option={themed}
          opts={{ renderer, width: 'auto', height: 'auto' }}
          style={{ height: '100%', width: '100%' }}
          onChartReady={onChartReady}
        />
      </div>
    </div>
  );
}
