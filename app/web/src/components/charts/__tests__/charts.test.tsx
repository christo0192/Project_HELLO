/**
 * Chart components: loading/empty/error states, sr-only data tables,
 * accessible summaries, reduced-motion gating, legend hover interaction,
 * and axe checks on rendered charts.
 *
 * ECharts runs in jsdom via the SVG renderer (see src/components/charts/
 * echarts.ts test-mode registration). ECharts warns once when the container
 * has no layout (clientWidth 0) — allowed via allowEchartsInitWarnings().
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  LineChart,
  buildLineSeries,
  RadarChart,
  GaugeChart,
  EChart,
  ChartDataTable,
  LegendHoverProvider,
  useLegendHover,
  type EChartsOption,
} from '..';
import {
  stubMatchMedia,
  stubResizeObserver,
  stubCanvasContext,
  allowEchartsInitWarnings,
} from '../../design/__tests__/helpers';

const lineData = [
  { label: 'Mon', value: 3 },
  { label: 'Tue', value: 5 },
  { label: 'Wed', value: 2 },
];

const radarData = [
  { indicator: 'Communication', value: 82 },
  { indicator: 'Problem solving', value: 74 },
];

describe('chart test environment', () => {
  beforeEach(() => {
    stubResizeObserver();
    stubCanvasContext();
    stubMatchMedia(false);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('EChart renders an accessible summary without keyboard claims', () => {
    allowEchartsInitWarnings();
    const option: EChartsOption = {
      xAxis: { type: 'category', data: ['a'] },
      yAxis: { type: 'value' },
      series: [{ type: 'line', data: [1] }],
    };
    render(<EChart option={option} ariaLabel="Sessions over time" height={120} renderer="svg" />);
    expect(screen.getByRole('img', { name: 'Sessions over time' })).toBeInTheDocument();
    // The canvas wrapper is hidden from AT — data lives in the sr-only table.
    const hidden = screen.getByRole('img', { name: 'Sessions over time' }).firstChild;
    expect(hidden).toHaveAttribute('aria-hidden', 'true');
  });

  it('ChartDataTable renders headers and rows', () => {
    render(
      <ChartDataTable
        caption="Sessions data"
        headers={['Date', 'Count']}
        rows={[{ cells: ['Mon', 3] }, { cells: ['Tue', 5] }]}
      />,
    );
    const table = screen.getByRole('table', { name: 'Sessions data' });
    expect(screen.getByRole('columnheader', { name: 'Date' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Tue' })).toBeInTheDocument();
    // Hidden by a wrapper: `sr-only` on a <table> box does not clip its rows.
    expect(table.closest('.sr-only')).not.toBeNull();
  });
});

describe('LineChart', () => {
  beforeEach(() => {
    stubResizeObserver();
    stubCanvasContext();
    stubMatchMedia(false);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a skeleton while loading', () => {
    render(<LineChart title="Sessions" data={[]} isLoading height={120} />);
    expect(document.querySelector('.skeleton')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('shows an error state with retry', () => {
    const onRetry = vi.fn();
    render(
        <LineChart
          title="Sessions"
          data={[]}
          error="Failed to load sessions"
          onRetry={onRetry}
          height={120}
        />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load sessions');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows an empty state with no data', () => {
    render(<LineChart title="Sessions" data={[]} height={120} />);
    expect(screen.getByText('No sessions yet')).toBeInTheDocument();
  });

  it('renders the chart with an sr-only data table when data exists', async () => {
    allowEchartsInitWarnings();
    const { container } = render(<LineChart title="Sessions over time" data={lineData} height={120} renderer="svg" />,
    );
    expect(screen.getByRole('img', { name: 'Sessions over time' })).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Sessions over time data' });
    // Hidden by a wrapper: `sr-only` on a <table> box does not clip its rows.
    expect(table.closest('.sr-only')).not.toBeNull();
    expect(screen.getByRole('cell', { name: 'Tue' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '5' })).toBeInTheDocument();
    await expect(container).toHaveNoViolations();
  });

  it('never animates a chart in (reported via chart ready)', async () => {
    allowEchartsInitWarnings();
    let optionAnimation: unknown = 'unset';
    render(
        <EChart
          option={{ xAxis: { type: 'category', data: ['a'] }, yAxis: { type: 'value' }, series: [{ type: 'line', data: [1] }] }}
          ariaLabel="Printed chart"
          height={120}
          renderer="svg"
          onChartReady={(instance) => {
            optionAnimation = instance.getOption().animation;
          }}
        />,
    );
    await waitFor(() => expect(optionAnimation).toBe(false));
  });
});

describe('LineChart truthfulness', () => {
  beforeEach(() => {
    stubResizeObserver();
    stubCanvasContext();
    stubMatchMedia(false);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('draws straight segments, never a spline that invents values between points', () => {
    // A spline through 2, 1, 1, 2 dips below 1 between the two 1s: a count of
    // people that never happened. Straight segments cannot overshoot.
    const { lines } = buildLineSeries(
      [{ name: 'Added', data: [{ label: '1 Sep', value: 2 }, { label: '2 Sep', value: 1 }, { label: '3 Sep', value: 1 }] }],
      { colors: ['#4E6BA6'] },
    );
    expect(lines).toHaveLength(1);
    expect(lines.every((line) => line.smooth === false)).toBe(true);
  });

  it('tells two series apart by marker shape, because the cycle has no hue', () => {
    const { lines } = buildLineSeries(
      [
        { name: 'One', data: [{ label: '1 Sep', value: 1 }] },
        { name: 'Two', data: [{ label: '1 Sep', value: 2 }] },
      ],
      { colors: ['#000000', '#111111'] },
    );
    expect(new Set(lines.map((line) => line.symbol)).size).toBe(2);
  });

  it('dashes the second line, because a marker is hidden on a dense series', () => {
    // Two series that mean opposite things, at 30 days: past 20 points the chart
    // shows no markers, so the dash is what still tells the lines apart.
    const days = Array.from({ length: 30 }, (_, i) => ({ label: `${i + 1} Sep`, value: i }));
    const { lines } = buildLineSeries(
      [{ name: 'One', data: days }, { name: 'Two', data: days }],
      { colors: ['#000000', '#111111'] },
    );
    expect(lines.every((line) => line.showSymbol === false)).toBe(true);
    expect(lines[0].lineStyle?.type).toBe('solid');
    expect(lines[1].lineStyle?.type).toEqual([6, 4]);
  });

  it('draws no area under a line: a wash would be a gradient by another name', () => {
    const { lines } = buildLineSeries([{ name: 'One', data: [{ label: '1 Sep', value: 1 }] }], { colors: ['#000000'] });
    expect(lines[0].areaStyle).toBeUndefined();
  });

  it('leaves a gap, not a zero, for a day one series does not have', () => {
    const { labels, lines } = buildLineSeries(
      [
        { name: 'Qualified', data: [{ label: '1 Sep', value: 40 }, { label: '3 Sep', value: 20 }] },
        { name: 'Disqualified', data: [{ label: '1 Sep', value: 10 }, { label: '2 Sep', value: 30 }, { label: '3 Sep', value: 5 }] },
      ],
      { colors: ['#398AA2', '#B45A72'] },
    );
    // The day only the second series has sits between its neighbours.
    expect(labels).toEqual(['1 Sep', '2 Sep', '3 Sep']);
    const qualified = lines[0].data as Array<number | null>;
    expect(qualified[labels.indexOf('2 Sep')]).toBeNull();
    expect(lines.every((line) => line.connectNulls === false)).toBe(true);
  });

  it('pairs a multi-series chart with one table column per series', () => {
    allowEchartsInitWarnings();
    render(
        <LineChart
          title="Screening outcomes"
          unit="%"
          series={[
            { name: 'Qualified', data: [{ label: '1 Sep', value: 40 }] },
            { name: 'Disqualified', data: [{ label: '1 Sep', value: 10 }, { label: '2 Sep', value: 30 }] },
          ]}
          height={120}
          renderer="svg"
        />,
    );
    const table = screen.getByRole('table', { name: 'Screening outcomes data' });
    expect(screen.getByRole('columnheader', { name: 'Qualified' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Disqualified' })).toBeInTheDocument();
    // A percent reads as one; a missing day reads as missing, not "0%".
    expect(screen.getByRole('cell', { name: '40%' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'No data' })).toBeInTheDocument();
    expect(table.textContent).not.toContain('0%No');
  });

  it('prints each line\'s own dash and marker in the legend', () => {
    // The legend used to draw the same bar for both, so a reader could not learn
    // which line was which without hovering for the tooltip.
    allowEchartsInitWarnings();
    const { container } = render(
      <LineChart
        title="Screening outcomes"
        unit="%"
        series={[
          { name: 'Qualified', data: [{ label: '1 Sep', value: 40 }] },
          { name: 'Disqualified', data: [{ label: '1 Sep', value: 10 }] },
        ]}
        height={120}
        renderer="svg"
      />,
    );
    const keys = [...container.querySelectorAll('[data-series-key]')];
    expect(keys).toHaveLength(2);
    const [solid, dashed] = keys.map((key) => key.querySelector('line')!);
    expect(solid.getAttribute('stroke-dasharray')).toBeNull();
    expect(dashed.getAttribute('stroke-dasharray')).toBe('6 4');
    expect(keys[0].querySelector('circle')).not.toBeNull();
    expect(keys[1].querySelector('rect')).not.toBeNull();
  });
});

describe('LegendHoverProvider', () => {
  it('provides the hovered index contract with a noop fallback', () => {
    let captured: { hoveredIndex: number | null; setHoveredIndex: (i: number | null) => void } | null = null;
    function Probe() {
      captured = useLegendHover();
      return <span>{captured.hoveredIndex}</span>;
    }
    render(<Probe />);
    expect(captured).not.toBeNull();
    expect(captured!.hoveredIndex).toBeNull();
    expect(() => captured!.setHoveredIndex(1)).not.toThrow();
  });

  it('delivers hover changes through the provider', () => {
    const onHoverChange = vi.fn();
    function Probe() {
      const { hoveredIndex, setHoveredIndex } = useLegendHover();
      return (
        <button type="button" onClick={() => setHoveredIndex(2)}>
          {hoveredIndex}
        </button>
      );
    }
    render(
      <LegendHoverProvider hoveredIndex={null} onHoverChange={onHoverChange}>
        <Probe />
      </LegendHoverProvider>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onHoverChange).toHaveBeenCalledWith(2);
  });
});

describe('RadarChart', () => {
  beforeEach(() => {
    stubResizeObserver();
    stubCanvasContext();
    stubMatchMedia(false);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows empty state before an assessment exists', () => {
    render(<RadarChart title="Scorecard" data={[]} height={120} />);
    expect(screen.getByText('No assessment yet')).toBeInTheDocument();
  });

  it('renders the radar with an sr-only table', () => {
    allowEchartsInitWarnings();
    render(<RadarChart title="Skill scorecard" data={radarData} height={120} renderer="svg" />,
    );
    expect(screen.getByRole('img', { name: 'Skill scorecard' })).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Skill scorecard data' });
    // Hidden by a wrapper: `sr-only` on a <table> box does not clip its rows.
    expect(table.closest('.sr-only')).not.toBeNull();
    expect(screen.getByRole('cell', { name: 'Communication' })).toBeInTheDocument();
  });
});

describe('GaugeChart', () => {
  beforeEach(() => {
    stubResizeObserver();
    stubCanvasContext();
    stubMatchMedia(false);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a disabled state when the quota limit is zero', () => {
    render(<GaugeChart title="Quota" value={10} max={0} height={120} />);
    expect(screen.getByText('Quota disabled')).toBeInTheDocument();
  });

  it('renders gauge data into the sr-only table', () => {
    allowEchartsInitWarnings();
    render(
        <GaugeChart
          title="Quota utilization"
          value={78}
          max={100}
          unit="%"
          sublabel="Monthly interviews"
          height={120}
          renderer="svg"
        />,
    );
    expect(screen.getByRole('img', { name: /Quota utilization/ })).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Quota utilization data' });
    // Hidden by a wrapper: `sr-only` on a <table> box does not clip its rows.
    expect(table.closest('.sr-only')).not.toBeNull();
    expect(screen.getByRole('cell', { name: '78%' })).toBeInTheDocument();
  });
});
