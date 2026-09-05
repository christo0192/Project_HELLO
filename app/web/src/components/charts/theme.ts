import type { EChartsOption } from 'echarts';
import type { Theme } from '../../lib/theme';

export interface ChartPalette {
  colors: string[];
  text: string;
  subtext: string;
  axisLine: string;
  splitLine: string;
  tooltipBg: string;
  tooltipBorder: string;
}

/**
 * Categorical chart palette derived from the approved HR screenshot cycle.
 * The `theme` argument remains for API compatibility; all application charts
 * intentionally render the single approved light-first palette.
 */
export function chartPalette(_theme: Theme): ChartPalette {
  return {
    colors: ['#4E6BA6', '#398AA2', '#1E7590', '#D8B5BE', '#938FB8', '#7BA7C7', '#A9CAD6', '#C4A6B8', '#6B8E9F', '#B5C8D8', '#8FB0A8', '#D0B8A0'],
    text: '#0f172a',
    subtext: '#5f6785',
    axisLine: '#dbe1ec',
    splitLine: '#f1f5f9',
    tooltipBg: '#ffffff',
    tooltipBorder: '#dbe1ec',
  };
}

export interface ChartTheme {
  palette: ChartPalette;
  /** Base option keys merged into every chart (theme + reduced motion). */
  base: EChartsOption;
}

/** Build the theme-aware base option for a resolved theme + motion state. */
export function chartTheme(theme: Theme, reducedMotion: boolean): ChartTheme {
  const palette = chartPalette(theme);
  const base: EChartsOption = {
    animation: !reducedMotion,
    animationDuration: 600,
    animationEasing: 'cubicOut',
    color: palette.colors,
    textStyle: {
      color: palette.text,
      fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
      fontSize: 12,
    },
    tooltip: {
      backgroundColor: 'rgba(255, 255, 255, 0.86)',
      borderColor: 'rgba(15, 23, 42, 0.08)',
      borderWidth: 1,
      textStyle: { color: palette.text, fontSize: 12 },
      padding: [8, 12],
      extraCssText:
        'border-radius: 12px; box-shadow: 0 1px 2px rgba(15,23,42,0.06), 0 10px 30px -10px rgba(15,23,42,0.25); backdrop-filter: blur(12px) saturate(1.3); -webkit-backdrop-filter: blur(12px) saturate(1.3);',
    },
  };
  return { palette, base };
}
