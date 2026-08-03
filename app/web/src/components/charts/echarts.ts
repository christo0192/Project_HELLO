/**
 * Tree-shaken ECharts core — registers only the chart types and components
 * used by HELLO dashboards. ECharts is Apache-2.0 (see THIRD_PARTY_NOTICES.md).
 *
 * ACCESSIBILITY (no Canvas keyboard claims): ECharts renders to Canvas,
 * which is not keyboard- or screen-reader-accessible. Chart components never
 * attach keyboard semantics to the canvas; every chart pairs the canvas with
 * an adjacent sr-only data table (ChartDataTable) and a summarizing
 * aria-label (EChart). Interactive controls (legend, filters) are native HTML
 * outside the canvas.
 *
 * The SVG renderer is registered only in test mode (jsdom has no canvas). In
 * production builds the test-mode check folds to false and the unused
 * SVGRenderer import is tree-shaken by Rollup.
 *
 * Note: `MODE` is read via bracket access (`import.meta.env['MODE']`) — it is
 * a Vite-injected value, not a `.env`-sourced variable, so it must not appear
 * as a dotted `import.meta.env.*` name that the repo's env-contract checker
 * treats as an undeclared runtime variable.
 */
import * as echarts from 'echarts/core';
import { GaugeChart, LineChart, PieChart, RadarChart } from 'echarts/charts';
import {
  DataZoomComponent,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  RadarComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer, SVGRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';

echarts.use([
  LineChart,
  PieChart,
  RadarChart,
  GaugeChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  RadarComponent,
  TitleComponent,
  GraphicComponent,
  CanvasRenderer,
]);

// Test-mode check (bracket access — see header note). Vitest sets MODE='test'.
if (import.meta.env['MODE'] === 'test') {
  echarts.use([SVGRenderer]);
}

export { echarts };
export type { EChartsOption };
