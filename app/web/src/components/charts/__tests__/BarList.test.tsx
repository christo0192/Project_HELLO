/**
 * BarList: the donut replacement. Asserts the figures and the table
 * semantics, not the bar pixels (the bars are decorative, `aria-hidden`).
 */
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import type { ReactNode } from 'react';
import { BarList, shareLabel } from '..';

function wrap(ui: ReactNode) {
  return <MemoryRouter>{ui}</MemoryRouter>;
}

const STAGES = [
  { label: 'New', value: 5, href: '/candidates?status=new' },
  { label: 'Screened', value: 6, href: '/candidates?status=screened' },
  { label: 'Rejected', value: 1, href: '/candidates?status=rejected' },
];

describe('shareLabel', () => {
  it('rounds to a whole percent', () => {
    expect(shareLabel(1, 3)).toBe('33%');
    expect(shareLabel(2, 3)).toBe('67%');
  });

  it('never prints a real, tiny share as 0%', () => {
    expect(shareLabel(1, 500)).toBe('<1%');
    expect(shareLabel(0, 500)).toBe('0%');
  });

  it('has no share without a whole', () => {
    expect(shareLabel(3, 0)).toBe('—');
  });
});

describe('BarList', () => {
  it('is a captioned data table: a row header per category, then count and share', () => {
    render(wrap(<BarList title="Pipeline by stage" data={STAGES} order="none" categoryHeader="Stage" />));
    const table = screen.getByRole('table', { name: 'Pipeline by stage data' });
    expect(within(table).getByRole('columnheader', { name: 'Stage' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Share' })).toBeInTheDocument();
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual(['New542%', 'Screened650%', 'Rejected18%']);
  });

  it('ranks by count by default, and keeps a meaningful order when asked', () => {
    const { unmount } = render(wrap(<BarList title="Ranked" data={STAGES} />));
    expect(screen.getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['Screened', 'New', 'Rejected']);
    unmount();
    render(wrap(<BarList title="Stages" data={STAGES} order="none" />));
    expect(screen.getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['New', 'Screened', 'Rejected']);
  });

  it('makes each category a drill-down link whose name carries the figure', () => {
    render(wrap(<BarList title="Stages" data={STAGES} linkHint="View these candidates." />));
    const link = screen.getByRole('link', { name: 'New: 5 (42%). View these candidates.' });
    expect(link).toHaveAttribute('href', '/candidates?status=new');
  });

  it('drops the share column when the rows are not parts of one whole', () => {
    render(
      wrap(
        <BarList
          title="Quota policy state"
          data={[
            { label: 'Enabled', value: 2 },
            { label: 'Global scope', value: 2 },
          ]}
          total={3}
          scale="total"
          showShare={false}
        />,
      ),
    );
    expect(screen.queryByRole('columnheader', { name: 'Share' })).not.toBeInTheDocument();
    expect(screen.getByRole('table').textContent).not.toContain('%');
  });

  it('shows an empty state instead of a table of zeros', () => {
    render(wrap(<BarList title="Nothing" data={[]} emptyTitle="No sessions yet" />));
    expect(screen.getByText('No sessions yet')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('announces loading and shows a retryable error', () => {
    const { unmount } = render(wrap(<BarList title="Stages" data={[]} isLoading />));
    expect(screen.getByRole('status', { name: 'Loading Stages' })).toBeInTheDocument();
    unmount();
    render(wrap(<BarList title="Stages" data={[]} error="Could not load" onRetry={() => {}} />));
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load');
  });

  it('has no axe violations', async () => {
    const { container } = render(wrap(<BarList title="Stages" data={STAGES} linkHint="View these candidates." />));
    await expect(container).toHaveNoViolations();
  });
});
