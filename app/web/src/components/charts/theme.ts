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
 * Semantic chart palette derived from the resolved theme. Values mirror the
 * CSS tokens in index.css (logo cyan #3996d2, navy #344158) so charts stay
 * in sync with surfaces without reading computed styles (test-safe).
 */
export function chartPalette(theme: Theme): ChartPalette {
  const dark = theme === 'dark';
  return {
    colors: dark
      ? ['#54a7d6', '#8fa3bd', '#2fb17f', '#d8a05c', '#ef6a6a', '#a99de0']
      : ['#3996d2', '#344158', '#0d8a63', '#b45409', '#d13b3b', '#7a6cc4'],
    text: dark ? '#e8eef5' : '#101f31',
    subtext: dark ? '#a6b4c5' : '#46586d',
    axisLine: dark ? '#2d4462' : '#c7d2de',
    splitLine: dark ? '#1e3048' : '#e2e8f0',
    tooltipBg: dark ? '#122032' : '#ffffff',
    tooltipBorder: dark ? '#2d4462' : '#e2e8f0',
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
