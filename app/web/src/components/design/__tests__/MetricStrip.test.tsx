/**
 * MetricStrip: one surface of related figures, divided by hairlines.
 * Semantics first: a named group, term/definition pairs for static figures,
 * links (not a <dl>) for drill-downs, and nothing rendered for a withheld one.
 */
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { MetricStrip } from '../MetricStrip';
import { stubMatchMedia } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MetricStrip', () => {
  it('is a group named by its heading, with each figure a term and its definition', () => {
    stubMatchMedia(true, '(prefers-reduced-motion: reduce)');
    render(
      <MetricStrip
        label="Reach"
        description="Getting to the candidate."
        items={[
          { label: 'Dialled', value: '285' },
          { label: 'Connect rate', value: '69%', context: 'Reached ÷ dialled' },
        ]}
      />,
    );
    const group = screen.getByRole('group', { name: 'Reach' });
    expect(group).toHaveAccessibleDescription('Getting to the candidate.');
    const terms = within(group).getAllByRole('term').map((t) => t.textContent);
    expect(terms).toEqual(['Dialled', 'Connect rate']);
    const defs = within(group).getAllByRole('definition').map((d) => d.textContent);
    expect(defs).toEqual(['285', '69%', 'Reached ÷ dialled']);
  });

  it('renders no cell at all for a figure withheld on purpose', () => {
    stubMatchMedia(true, '(prefers-reduced-motion: reduce)');
    const { container } = render(
      <MetricStrip label="Reach" items={[false, { label: 'Dialled', value: '285' }, null]} />,
    );
    expect(container.querySelectorAll('dl > div')).toHaveLength(1);
  });

  it('turns drill-down figures into links named by the caller', () => {
    stubMatchMedia(true, '(prefers-reduced-motion: reduce)');
    render(
      <MemoryRouter>
        <MetricStrip
          label="Pipeline"
          hideLabel
          size="hero"
          items={[
            { label: 'Candidates', value: '24', href: '/candidates', ariaLabel: '24 candidates in pipeline. View all candidates.' },
            { label: 'Awaiting screening', value: '5', href: '/candidates?status=new' },
          ]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('group', { name: 'Pipeline' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '24 candidates in pipeline. View all candidates.' })).toHaveAttribute(
      'href',
      '/candidates',
    );
    // Without an explicit name the link still says what it is and how many.
    expect(screen.getByRole('link', { name: 'Awaiting screening: 5' })).toHaveAttribute(
      'href',
      '/candidates?status=new',
    );
    expect(document.querySelector('dl')).toBeNull();
  });

  it('prints a plain figure in ink, and a figure with a meaning in its family text shade', () => {
    render(
      <MetricStrip
        label="Reach"
        items={[
          { label: 'Plain', value: '1' },
          { label: 'Underway', value: '2', figureTone: 'info' },
          { label: 'Good', value: '3', figureTone: 'success' },
          { label: 'Open', value: '4', figureTone: 'warning' },
          { label: 'Ended', value: '5', figureTone: 'closed' },
        ]}
      />,
    );
    expect(screen.getByText('1')).toHaveClass('text-ink');
    expect(screen.getByText('2')).toHaveClass('text-moving-text');
    expect(screen.getByText('3')).toHaveClass('text-success-text');
    expect(screen.getByText('4')).toHaveClass('text-warning-text');
    expect(screen.getByText('5')).toHaveClass('text-closed-text');
    // A figure tone alone adds no dot: the dot is the separate `tone`.
    expect(screen.getByText('Good').parentElement!.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('lets a figure that needs attention outrank its tone, and draws a dot in the family mark', () => {
    render(
      <MetricStrip
        label="Reach"
        items={[
          { label: 'Overdue', value: '6', figureTone: 'info', attention: true },
          { label: 'Disqualified', value: '7', tone: 'closed', figureTone: 'closed' },
          { label: 'Busy', value: '8', tone: 'info' },
        ]}
      />,
    );
    expect(screen.getByText('6')).toHaveClass('text-warning-text');
    expect(screen.getByText('Disqualified').parentElement!.querySelector('[aria-hidden="true"]')).toHaveClass('bg-closed');
    expect(screen.getByText('Busy').parentElement!.querySelector('[aria-hidden="true"]')).toHaveClass('bg-moving');
  });

  it('leaves a figure that could not be read in ink: a dash means nothing yet', () => {
    render(<MetricStrip label="Reach" items={[{ label: 'Connect rate', value: '—', figureTone: 'info' }]} />);
    expect(screen.getByText('—').parentElement).toHaveClass('text-ink');
  });

  it('shows a skeleton, not a zero, while a figure loads', () => {
    render(<MetricStrip label="Reach" items={[{ label: 'Dialled', value: '0', loading: true }]} />);
    expect(document.querySelector('.skeleton')).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('holds a loading figure at its final height without showing its context', () => {
    // The line can quote what has not been read yet: "Of 0 access entries".
    render(
      <MetricStrip
        label="Reach"
        items={[{ label: 'Allowed', value: '0', context: 'Of 0 access entries', loading: true }]}
      />,
    );
    expect(screen.getByText('Of 0 access entries')).toHaveClass('invisible');
  });

  it('shows the context once the figure is in', () => {
    render(<MetricStrip label="Reach" items={[{ label: 'Allowed', value: '4', context: 'Of 9 entries' }]} />);
    expect(screen.getByText('Of 9 entries')).not.toHaveClass('invisible');
  });

  it('uses sentence case and tabular figures, never an uppercase eyebrow', () => {
    stubMatchMedia(true, '(prefers-reduced-motion: reduce)');
    const { container } = render(
      <MetricStrip label="Call volume" items={[{ label: 'Call attempts', value: '499' }]} />,
    );
    expect(container.querySelector('.uppercase')).toBeNull();
    expect(screen.getByRole('definition')).toHaveClass('tabular-nums');
  });

  it('has no axe violations', async () => {
    stubMatchMedia(true, '(prefers-reduced-motion: reduce)');
    const { container } = render(
      <MemoryRouter>
        <MetricStrip
          label="Team decision"
          footnote="7 screened candidates are still waiting for a first look."
          items={[
            { label: 'Advanced', value: '13', context: 'At Reference check' },
            { label: 'Advance rate', value: '100%', href: '/x', ariaLabel: 'Advance rate 100 percent' },
          ]}
        />
      </MemoryRouter>,
    );
    await expect(container).toHaveNoViolations();
  });

  it('names a drill-down by its visible label and describes it with the context line', () => {
    stubMatchMedia(true, '(prefers-reduced-motion: reduce)');
    render(
      <MemoryRouter>
        <MetricStrip
          label="Pipeline"
          items={[{ label: 'Awaiting decision', value: '6', context: 'Screened, ready to review', href: '/candidates?status=screened' }]}
        />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: 'Awaiting decision: 6' });
    expect(link).toHaveAccessibleDescription('Screened, ready to review');
  });

  it('says "Not available" for a figure that could not be read, never a silent dash', () => {
    stubMatchMedia(true, '(prefers-reduced-motion: reduce)');
    render(<MetricStrip label="Overview" items={[{ label: 'Sessions', value: '—' }]} />);
    expect(screen.getByText('Not available')).toHaveClass('sr-only');
  });
});
