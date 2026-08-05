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
  DonutChart,
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

const donutData = [
  { label: 'screening', value: 6 },
  { label: 'completed', value: 3 },
  { label: 'rejected', value: 1 },
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
    expect(table).toHaveClass('sr-only');
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
    expect(table).toHaveClass('sr-only');
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

describe('DonutChart', () => {
  beforeEach(() => {
    stubResizeObserver();
    stubCanvasContext();
    stubMatchMedia(false);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows empty state with no candidates', () => {
    render(wrap(<DonutChart title="Status" data={[]} height={120} />));
    expect(screen.getByText('No candidates')).toBeInTheDocument();
  });

  it('renders a native legend and sr-only table with data', async () => {
    allowEchartsInitWarnings();
    const { container } = render(
      wrap(<DonutChart title="Candidate status" data={donutData} height={120} renderer="svg" />),
    );
    const legendButtons = screen.getAllByRole('button');
    expect(legendButtons).toHaveLength(donutData.length);
    expect(screen.getByRole('button', { name: /screening/ })).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Candidate status data' });
    expect(table).toHaveClass('sr-only');
    expect(screen.getByRole('cell', { name: 'rejected' })).toBeInTheDocument();
    await expect(container).toHaveNoViolations();
  });

  it('legend hover sets aria-pressed (hover-dim contract)', () => {
    allowEchartsInitWarnings();
    render(
      wrap(<DonutChart title="Candidate status" data={donutData} height={120} renderer="svg" />),
    );
    const button = screen.getByRole('button', { name: /screening/ });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    fireEvent.mouseEnter(button);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    fireEvent.mouseLeave(button);
    expect(button).toHaveAttribute('aria-pressed', 'false');
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
    expect(table).toHaveClass('sr-only');
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
    expect(table).toHaveClass('sr-only');
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
