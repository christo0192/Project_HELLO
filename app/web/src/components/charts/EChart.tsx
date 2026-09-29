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
  /** Canvas in browsers; test mode auto-falls back to SVG because jsdom has no canvas. */
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

  // Init ONCE per renderer. Callers build `option` as a fresh literal on
  // every render, so keying the init effect on the option would dispose and
  // rebuild the canvas on every parent re-render (the dashboard renders ~6×
  // while its fetches land) and replay the entrance animation each time.
  const themedRef = useRef(themed);
  themedRef.current = themed;
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const activeRenderer = import.meta.env['MODE'] === 'test' && renderer === 'canvas' ? 'svg' : renderer;
    const instance = echarts.init(node, undefined, { renderer: activeRenderer });
    instanceRef.current = instance;
    instance.setOption(themedRef.current, true);
    readyRef.current?.(instance);

    // Resize with the CONTAINER, not only the window (a panel can change width
    // without the window moving), and never into a sliver. A box a few pixels
    // wide is a transient mid-layout measurement (a full-page capture resizing
    // the viewport produced one); drawing into it left the whole series
    // squeezed into a vertical line until the next resize. The last good size
    // is kept instead, and the next real size redraws.
    const resize = () => {
      if (node.clientWidth < 48 || node.clientHeight < 32) return;
      instance.resize();
    };
    window.addEventListener('resize', resize);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(node);
    return () => {
      window.removeEventListener('resize', resize);
      observer?.disconnect();
      instance.dispose();
      instanceRef.current = null;
    };
  }, [renderer]);

  useEffect(() => {
    instanceRef.current?.setOption(themed, true);
  }, [themed]);

  return (
    <div role="img" aria-label={ariaLabel} className={cx('w-full', className)} style={{ height }}>
      <div ref={containerRef} aria-hidden="true" className="h-full w-full" />
    </div>
  );
}
