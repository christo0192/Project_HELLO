import type { EChartsOption } from 'echarts';

/** The four status families (index.css), for a series that means one of them. */
export type ChartFamily = 'moving' | 'ready' | 'unresolved' | 'closed';

export interface ChartPalette {
  colors: string[];
  /** Each family's mark, for a series or an arc whose meaning is that family. */
  families: Record<ChartFamily, string>;
  text: string;
  subtext: string;
  axisLine: string;
  splitLine: string;
  /** The paper behind a chart: marker rims, slice borders. */
  surface: string;
  tooltipBg: string;
  tooltipBorder: string;
}

/**
 * A token's resolved value. The canvas cannot read `var(--x)`, so a chart takes
 * the computed value; a custom property's computed value has any `var()` in it
 * already substituted, so the semantic names resolve too.
 */
function token(name: string): string {
  if (typeof document === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * THE ONE PLACE CHARTS GET A COLOUR. Everything here is read from the tokens in
 * index.css, so a chart cannot drift from the page around it.
 *
 * The categorical cycle is the four status families, then a quiet ink step. Every
 * pair of the four is validated for colour-blind readers and on paper, in
 * logsheet-tokens.test.ts. A series that means a verdict or an outcome passes its
 * family explicitly (`families`, `LineChartSeries.family`), never its place in the
 * cycle. It is still told apart by its printed label, its dash and its marker shape
 * (series.ts), and axis, label and legend text stays ink. The voice hue never
 * appears here: orange means the candidate's voice and nothing else.
 */
export function chartPalette(): ChartPalette {
  return {
    colors: [token('--moving'), token('--ready'), token('--unresolved'), token('--closed'), token('--ink-3')],
    families: {
      moving: token('--moving'),
      ready: token('--ready'),
      unresolved: token('--unresolved'),
      closed: token('--closed'),
    },
    text: token('--ink'),
    subtext: token('--ink-3'),
    axisLine: token('--rule-2'),
    splitLine: token('--rule'),
    surface: token('--paper'),
    tooltipBg: token('--paper'),
    tooltipBorder: token('--rule-2'),
  };
}

export interface ChartTheme {
  palette: ChartPalette;
  /** Base option keys merged into every chart. */
  base: EChartsOption;
}

/**
 * The base option for every chart. No entrance at any setting, so there is
 * nothing for reduced motion to switch off: a chart is printed, not drawn in.
 */
export function chartTheme(): ChartTheme {
  const palette = chartPalette();
  const base: EChartsOption = {
    animation: false,
    color: palette.colors,
    textStyle: {
      color: palette.text,
      // The app face first, so axis labels match the figures beside them.
      fontFamily: "'IBM Plex Sans Variable', ui-sans-serif, system-ui, -apple-system, sans-serif",
      fontSize: 12,
    },
    tooltip: {
      backgroundColor: palette.tooltipBg,
      borderColor: palette.tooltipBorder,
      borderWidth: 1,
      textStyle: { color: palette.text, fontSize: 12 },
      padding: [8, 12],
      // A tooltip is a floating layer, so the one shadow token applies. ECharts
      // renders it as HTML, so the custom properties resolve.
      extraCssText: 'border-radius: var(--radius-control); box-shadow: var(--shadow-pop);',
    },
  };
  return { palette, base };
}
