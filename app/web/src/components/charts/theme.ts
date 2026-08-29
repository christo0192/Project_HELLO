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
    subtext: '#334155',
    axisLine: '#dbe1ec',
    splitLine: '#eaeef6',
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
      backgroundColor: palette.tooltipBg,
      borderColor: palette.tooltipBorder,
      borderWidth: 1,
      textStyle: { color: palette.text },
      padding: [8, 10],
      extraCssText: 'border-radius: 8px; box-shadow: 0 4px 12px rgb(16 31 49 / 0.12);',
    },
  };
  return { palette, base };
}
