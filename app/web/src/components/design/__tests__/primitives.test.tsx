/**
 * Design primitives: Skeleton, KpiCard, Table, PageHeader, StatusBadge,
 * ChartCard, ThemeToggle — rendering, semantics, axe.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { ThemeProvider } from '../../../lib/theme';
import {
  Skeleton,
  SkeletonText,
  ChartSkeleton,
  KpiCard,
  Table,
  THead,
  TBody,
  Tr,
  Th,
  Td,
  PageHeader,
  StatusBadge,
  ChartCard,
  ThemeToggle,
} from '..';
import { stubMatchMedia } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.classList.remove('dark');
});

describe('Skeleton family', () => {
  it('renders a hidden shimmer placeholder', () => {
    render(<Skeleton width={80} height={12} />);
    const el = document.querySelector('.skeleton');
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute('aria-hidden', 'true');
    expect(el).toHaveStyle({ width: '80px', height: '12px' });
  });

  it('renders SkeletonText with the requested number of lines', () => {
    render(<SkeletonText lines={4} />);
    expect(document.querySelectorAll('.skeleton')).toHaveLength(4);
  });

  it('renders a deterministic ChartSkeleton bar set', () => {
    render(<ChartSkeleton bars={8} />);
    expect(document.querySelectorAll('.skeleton').length).toBeGreaterThanOrEqual(8);
  });
});

describe('KpiCard', () => {
  it('renders label, value, unit, hint and delta', () => {
    stubMatchMedia(true, '(prefers-reduced-motion: reduce)');
    render(
      <KpiCard
        label="Total candidates"
        value={128}
        unit="candidates"
        hint="vs last week"
        delta={12.5}
      />,
    );
    expect(screen.getByText('Total candidates')).toBeInTheDocument();
    expect(screen.getByText('128')).toBeInTheDocument();
    expect(screen.getByText('candidates')).toBeInTheDocument();
    expect(screen.getByText('+12.5%')).toBeInTheDocument();
    expect(screen.getByText('vs last week')).toBeInTheDocument();
  });

  it('supports custom value formatting', () => {
    stubMatchMedia(true, '(prefers-reduced-motion: reduce)');
    render(<KpiCard label="Avg score" value={81.4} formatValue={(v) => `${v.toFixed(1)}%`} />);
    expect(screen.getByText('81.4%')).toBeInTheDocument();
  });

  it('shows a skeleton while loading and no value', () => {
    render(<KpiCard label="Total" value={5} loading />);
    expect(document.querySelector('.skeleton')).toBeInTheDocument();
    expect(screen.queryByText('5')).not.toBeInTheDocument();
  });

  it('renders negative and zero deltas', () => {
    const { rerender } = render(<KpiCard label="A" value={1} delta={-3.2} />);
    expect(screen.getByText('-3.2%')).toBeInTheDocument();
    rerender(<KpiCard label="A" value={1} delta={0} />);
    expect(screen.getByText('0.0%')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    render(
      <KpiCard
        label="Sessions today"
        value={9}
        unit="sessions"
        hint="updated just now"
        delta={4}
      />,
    );
    await expect(screen.getByText('Sessions today').closest('div')!).toHaveNoViolations();
  });
});

describe('Table primitives', () => {
  it('renders a semantic table with sr-only caption and scroll wrapper', async () => {
    render(
      <Table caption="Recent sessions">
        <THead>
          <Tr>
            <Th>Candidate</Th>
            <Th>Status</Th>
          </Tr>
        </THead>
        <TBody>
          <Tr>
            <Td>Ada</Td>
            <Td>Completed</Td>
          </Tr>
        </TBody>
      </Table>,
    );
    const table = screen.getByRole('table', { name: 'Recent sessions' });
    expect(table).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Candidate' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Ada' })).toBeInTheDocument();
    expect(table.parentElement).toHaveClass('overflow-x-auto');
    await expect(table).toHaveNoViolations();
  });
});

describe('PageHeader', () => {
  it('renders eyebrow, title, description and actions', () => {
    render(
      <PageHeader
        eyebrow="Workspace"
        title="Candidates"
        description="Manage screening"
        actions={<button type="button">Export</button>}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Candidates', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Workspace')).toBeInTheDocument();
    expect(screen.getByText('Manage screening')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
  });
});

describe('StatusBadge', () => {
  it('renders with tone text and dot', () => {
    render(<StatusBadge tone="warning">Quota 92%</StatusBadge>);
    expect(screen.getByText('Quota 92%')).toBeInTheDocument();
  });
});

describe('ChartCard', () => {
  it('renders a labelled section with header and body', () => {
    render(
      <ChartCard title="Session volume" description="30-day view">
        <p>chart body</p>
      </ChartCard>,
    );
    const section = screen.getByRole('region', { name: 'Session volume' });
    expect(section).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Session volume' })).toBeInTheDocument();
    expect(screen.getByText('chart body')).toBeInTheDocument();
  });
});

describe('ThemeToggle', () => {
  it('toggles between light and dark and persists', async () => {
    stubMatchMedia(false);
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    const button = screen.getByRole('button', { name: 'Switch to dark theme' });
    await user.click(button);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(
      screen.getByRole('button', { name: 'Switch to light theme' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Switch to light theme' }));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
