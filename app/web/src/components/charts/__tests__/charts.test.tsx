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
import type { ReactNode } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ThemeProvider } from '../../../lib/theme';
import {
  LineChart,
  buildLineSeries,
  RadarChart,
  GaugeChart,
  EChart,
  ChartDataTable,
  ChartReveal,
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

function wrap(ui: ReactNode) {
  return <ThemeProvider>{ui}</ThemeProvider>;
}

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
    render(wrap(<EChart option={option} ariaLabel="Sessions over time" height={120} renderer="svg" />));
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
    render(wrap(<LineChart title="Sessions" data={[]} isLoading height={120} />));
    expect(document.querySelector('.skeleton')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('shows an error state with retry', () => {
    const onRetry = vi.fn();
    render(
      wrap(
        <LineChart
          title="Sessions"
          data={[]}
          error="Failed to load sessions"
          onRetry={onRetry}
          height={120}
        />,
      ),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load sessions');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows an empty state with no data', () => {
    render(wrap(<LineChart title="Sessions" data={[]} height={120} />));
    expect(screen.getByText('No sessions yet')).toBeInTheDocument();
  });

  it('renders the chart with an sr-only data table when data exists', async () => {
    allowEchartsInitWarnings();
    const { container } = render(
      wrap(<LineChart title="Sessions over time" data={lineData} height={120} renderer="svg" />),
    );
    expect(screen.getByRole('img', { name: 'Sessions over time' })).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Sessions over time data' });
    // Hidden by a wrapper: `sr-only` on a <table> box does not clip its rows.
    expect(table.closest('.sr-only')).not.toBeNull();
    expect(screen.getByRole('cell', { name: 'Tue' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '5' })).toBeInTheDocument();
    await expect(container).toHaveNoViolations();
  });

  it('gates animation under reduced motion (reported via chart ready)', async () => {
    allowEchartsInitWarnings();
    stubMatchMedia(true, '(prefers-reduced-motion: reduce)');
    let optionAnimation: unknown = 'unset';
    render(
      wrap(
        <EChart
          option={{ xAxis: { type: 'category', data: ['a'] }, yAxis: { type: 'value' }, series: [{ type: 'line', data: [1] }] }}
          ariaLabel="Reduced chart"
          height={120}
          renderer="svg"
          onChartReady={(instance) => {
            optionAnimation = instance.getOption().animation;
          }}
        />,
      ),
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
      wrap(
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
      ),
    );
    const table = screen.getByRole('table', { name: 'Screening outcomes data' });
    expect(screen.getByRole('columnheader', { name: 'Qualified' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Disqualified' })).toBeInTheDocument();
    // A percent reads as one; a missing day reads as missing, not "0%".
    expect(screen.getByRole('cell', { name: '40%' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'No data' })).toBeInTheDocument();
    expect(table.textContent).not.toContain('0%No');
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
    render(wrap(<RadarChart title="Scorecard" data={[]} height={120} />));
    expect(screen.getByText('No assessment yet')).toBeInTheDocument();
  });

  it('renders the radar with an sr-only table', () => {
    allowEchartsInitWarnings();
    render(
      wrap(<RadarChart title="Skill scorecard" data={radarData} height={120} renderer="svg" />),
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
    render(wrap(<GaugeChart title="Quota" value={10} max={0} height={120} />));
    expect(screen.getByText('Quota disabled')).toBeInTheDocument();
  });

  it('renders gauge data into the sr-only table', () => {
    allowEchartsInitWarnings();
    render(
      wrap(
        <GaugeChart
          title="Quota utilization"
          value={78}
          max={100}
          unit="%"
          sublabel="Monthly interviews"
          height={120}
          renderer="svg"
        />,
      ),
    );
    expect(screen.getByRole('img', { name: /Quota utilization/ })).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Quota utilization data' });
    // Hidden by a wrapper: `sr-only` on a <table> box does not clip its rows.
    expect(table.closest('.sr-only')).not.toBeNull();
    expect(screen.getByRole('cell', { name: '78%' })).toBeInTheDocument();
  });
});

describe('ChartReveal', () => {
  beforeEach(() => {
    stubMatchMedia(false);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('skips the reveal entirely under reduced motion', () => {
    stubMatchMedia(true, '(prefers-reduced-motion: reduce)');
    const { container } = render(<ChartReveal>content</ChartReveal>);
    expect(container.textContent).toBe('content');
    expect(container.querySelector('[style*="clip-path"]')).toBeNull();
  });

  it('renders children without a production-only motion component dependency', () => {
    const { container } = render(<ChartReveal>content</ChartReveal>);
    expect(container.textContent).toBe('content');
    expect(container.querySelector('[style*="clip-path"]')).toBeNull();
  });
});
