import { useEffect, useMemo, useRef } from 'react';
import type { EChartsOption } from 'echarts';
import type { ECharts as EChartsInstance } from 'echarts/core';
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
 * Shared ECharts binding.
 *
 * Do not use the `echarts-for-react` wrapper here: production bundling can
 * resolve its CommonJS default export to an object, which React treats as an
 * invalid element type. Initialising ECharts directly keeps the dashboard
 * render path free of third-party React component interop.
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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<EChartsInstance | null>(null);
  const readyRef = useRef(onChartReady);
  readyRef.current = onChartReady;

  const themed = useMemo(() => {
    const { base } = chartTheme(theme, reducedMotion);
    return mergeThemedOption(base, option);
  }, [option, theme, reducedMotion]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const instance = echarts.init(node, undefined, { renderer });
    instanceRef.current = instance;
    instance.setOption(themed, true);
    readyRef.current?.(instance);

    const resize = () => instance.resize();
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      instance.dispose();
      instanceRef.current = null;
    };
  }, [renderer, themed]);

  useEffect(() => {
    instanceRef.current?.setOption(themed, true);
  }, [themed]);

  return (
    <div role="img" aria-label={ariaLabel} className={cx('w-full', className)} style={{ height }}>
      <div ref={containerRef} aria-hidden="true" className="h-full w-full" />
    </div>
  );
}
