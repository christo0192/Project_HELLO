/**
 * What a chart hands to ECharts, so a colour's meaning is asserted rather than a
 * canvas jsdom cannot draw. The stylesheet is not loaded under jsdom, so the test
 * declares the real index.css :root block on the document before reading it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render } from '@testing-library/react';
import type { EChartsOption } from 'echarts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GaugeChart, LineChart, RadarChart } from '..';

const drawn = vi.hoisted(() => ({ option: null as EChartsOption | null }));

vi.mock('../EChart', () => ({
  EChart: ({ option }: { option: EChartsOption }) => {
    drawn.option = option;
    return null;
  },
}));

const CSS = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
const rootBlock = /:root \{([\s\S]*?)\n {2}\}/.exec(CSS)![1];
const value = (name: string) => new RegExp(`^\\s*${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`, 'm').exec(rootBlock)![1];

/** The first series of the option the chart last drew. */
function firstSeries(): Record<string, Record<string, unknown>> {
  const { series } = drawn.option as { series: Array<Record<string, Record<string, unknown>>> };
  return series[0];
}

let style: HTMLStyleElement;
beforeEach(() => {
  drawn.option = null;
  style = document.createElement('style');
  style.textContent = `:root {${rootBlock}}`;
  document.head.appendChild(style);
});
afterEach(() => style.remove());

describe('GaugeChart', () => {
  it('draws quota use as underway', () => {
    render(<GaugeChart title="Quota" value={40} max={100} />);
    expect(firstSeries().progress.itemStyle).toEqual({ color: value('--moving') });
  });

  it('asks for a second look once it crosses 85%, never by a place in the cycle', () => {
    render(<GaugeChart title="Quota" value={85} max={100} />);
    expect(firstSeries().progress.itemStyle).toEqual({ color: value('--unresolved') });
  });
});

describe('RadarChart', () => {
  it("draws one candidate's skill scores in ink: one shape spans several ratings, so no one family fits it", () => {
    render(<RadarChart title="Skills" data={[{ indicator: 'Depth', value: 3 }]} />);
    const series = firstSeries();
    expect(series.lineStyle.color).toBe(value('--ink'));
    expect(series.itemStyle.color).toBe(value('--ink'));
    expect(series.areaStyle.color).toBe(value('--ink'));
  });
});

describe('LineChart', () => {
  it('draws a single series in the first of the cycle', () => {
    render(<LineChart title="Added" data={[{ label: '1 Sep', value: 2 }]} unit="candidates" />);
    expect(firstSeries().lineStyle.color).toBe(value('--moving'));
  });

  it('draws a series that means an outcome in its family, its legend key too', () => {
    const { container } = render(
      <LineChart
        title="Outcomes"
        series={[
          { name: 'Qualified', family: 'ready', data: [{ label: '1 Sep', value: 2 }] },
          { name: 'Disqualified', family: 'closed', data: [{ label: '1 Sep', value: 1 }] },
        ]}
        unit="%"
      />,
    );
    const { series } = drawn.option as { series: Array<{ lineStyle: { color: string } }> };
    expect(series.map((line) => line.lineStyle.color)).toEqual([value('--ready'), value('--closed')]);
    const keys = [...container.querySelectorAll('[data-series-key] line')].map((line) => line.getAttribute('stroke'));
    expect(keys).toEqual([value('--ready'), value('--closed')]);
  });
});
