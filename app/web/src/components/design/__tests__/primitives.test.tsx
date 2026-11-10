/**
 * Design primitives: Skeleton, Table, PageHeader, StatusBadge,
 * ChartCard — rendering, semantics, axe.
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
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
} from '..';

afterEach(() => {
  vi.unstubAllGlobals();
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

  it('holds a ChartSkeleton open at the height of the chart it stands in for', () => {
    const { container } = render(<ChartSkeleton height={200} />);
    expect(container.firstElementChild).toHaveStyle({ minHeight: '200px' });
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

  /** jsdom has no layout: give every element the widths a narrow screen would. */
  function sideways(scrollWidth: number, clientWidth: number) {
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(scrollWidth);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(clientWidth);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
  }

  const wide = () => (
    <Table caption="Cohorts" focusWhenScrolling>
      <TBody>
        <Tr>
          <Td>Week</Td>
        </Tr>
      </TBody>
    </Table>
  );

  it('becomes a named, focusable region while it scrolls sideways, so a keyboard can scroll it', async () => {
    sideways(900, 390);
    render(wide());
    const region = screen.getByRole('region', { name: 'Cohorts' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toContainElement(screen.getByRole('table', { name: 'Cohorts' }));
  });

  it('adds no tab stop while it fits', () => {
    sideways(600, 600);
    render(wide());
    expect(screen.queryByRole('region')).toBeNull();
    expect(screen.getByRole('table').parentElement).not.toHaveAttribute('tabindex');
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
