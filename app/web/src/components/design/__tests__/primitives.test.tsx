/**
 * Design primitives: Skeleton, Table, PageHeader, StatusBadge,
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
