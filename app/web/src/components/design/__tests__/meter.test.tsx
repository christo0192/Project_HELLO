/**
 * Candidate design primitives: Meter, SurfaceCard, Tag.
 *
 * The scorecard defect these fix was not "the bars look small" — it was
 * that a bar's colour was the ONLY carrier of its value and the element
 * had no accessible semantics at all. These tests assert the redundancy
 * (number AND band word AND colour) and the ARIA contract, and include the
 * negative control that proves the depth guard is live rather than
 * decorative.
 */

import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import {
  BAND_LABEL,
  CandidateEmptyState,
  CandidateErrorState,
  MAX_SURFACE_DEPTH,
  Meter,
  SurfaceCard,
  Tag,
  clampScore,
  meterBand,
} from '../candidate';

describe('meterBand', () => {
  it.each([
    [0, 10, 'low'],
    [4.9, 10, 'low'],
    [5, 10, 'fair'],
    [6.9, 10, 'fair'],
    [7, 10, 'strong'],
    [10, 10, 'strong'],
    // Default fractions on the 0–100 scale.
    [49, 100, 'low'],
    [50, 100, 'fair'],
    [69, 100, 'fair'],
    [70, 100, 'strong'],
  ])('maps %s/%s to %s', (value, max, expected) => {
    expect(meterBand(value, max)).toBe(expected);
  });

  it.each([
    [49, 'low'],
    [50, 'fair'],
    [74, 'fair'],
    [75, 'strong'],
  ])(
    'honours the overall score\'s own legacy cut-points at %s/100',
    (value, expected) => {
      expect(meterBand(value, 100, { fair: 0.5, strong: 0.75 })).toBe(expected);
    },
  );

  it('never divides by a zero scale', () => {
    expect(meterBand(0, 0)).toBe('low');
  });
});

describe('clampScore', () => {
  it.each([
    [-5, 10, 0],
    [99, 10, 10],
    [7, 10, 7],
    [Number.NaN, 10, 0],
  ])('clamps %s on a 0–%s scale to %s', (value, max, expected) => {
    expect(clampScore(value, max)).toBe(expected);
  });
});

describe('Meter', () => {
  it('exposes the full ARIA meter contract', () => {
    render(<Meter label="Clarity" value={4} />);
    const meter = screen.getByRole('meter', { name: 'Clarity' });
    expect(meter).toHaveAttribute('aria-valuenow', '4');
    expect(meter).toHaveAttribute('aria-valuemin', '0');
    expect(meter).toHaveAttribute('aria-valuemax', '10');
    expect(meter).toHaveAttribute('aria-valuetext', '4 out of 10 — Low');
  });

  it('renders the numeric value AND the band word, not colour alone', () => {
    render(<Meter label="Fit score" value={8} />);
    expect(screen.getByText('8/10')).toBeInTheDocument();
    expect(screen.getByText(BAND_LABEL.strong)).toBeInTheDocument();
  });

  it('renders figures in a monospace, tabular face', () => {
    render(<Meter label="Score" value={3} />);
    const figure = screen.getByText('3/10');
    expect(figure.className).toContain('font-mono');
    expect(figure.className).toContain('tabular-nums');
  });

  it('carries a 0–100 scale for the overall score', () => {
    render(<Meter label="Overall score" value={36} max={100} emphasis />);
    const meter = screen.getByRole('meter', { name: 'Overall score' });
    expect(meter).toHaveAttribute('aria-valuemax', '100');
    expect(meter).toHaveAttribute('aria-valuetext', '36 out of 100 — Low');
    expect(screen.getByText('36/100')).toBeInTheDocument();
  });

  it('clamps out-of-range values instead of overflowing the track', () => {
    render(<Meter label="Impact" value={42} />);
    expect(screen.getByRole('meter', { name: 'Impact' })).toHaveAttribute(
      'aria-valuenow',
      '10',
    );
  });

  it('has no axe violations', async () => {
    const { container } = render(<Meter label="Grammar" value={6} />);
    await expect(container).toHaveNoViolations();
  });

  it('gives every band a distinct fill and a distinct word', () => {
    const words = new Set(Object.values(BAND_LABEL));
    expect(words.size).toBe(3);
    const { container } = render(
      <>
        <Meter label="A" value={1} />
        <Meter label="B" value={5} />
        <Meter label="C" value={9} />
      </>,
    );
    const bands = [...container.querySelectorAll('[data-band]')].map((el) =>
      el.getAttribute('data-band'),
    );
    expect(bands).toEqual(['low', 'fair', 'strong']);
  });
});

describe('SurfaceCard', () => {
  it('renders two distinguishable levels', () => {
    const { container } = render(
      <SurfaceCard>
        <SurfaceCard level="sunken">nested</SurfaceCard>
      </SurfaceCard>,
    );
    const levels = [...container.querySelectorAll('[data-surface-level]')].map((el) => [
      el.getAttribute('data-surface-level'),
      el.getAttribute('data-surface-depth'),
    ]);
    expect(levels).toEqual([
      ['base', '1'],
      ['sunken', '2'],
    ]);
  });

  it('names a section from its visible heading', () => {
    render(
      <SurfaceCard as="section" labelledBy="h">
        <h3 id="h">Communication</h3>
      </SurfaceCard>,
    );
    expect(screen.getByRole('region', { name: 'Communication' })).toBeInTheDocument();
  });

  it('gives each mount its own accessible name — no shared ids', () => {
    render(
      <>
        <SurfaceCard as="section" labelledBy="a">
          <h3 id="a">First</h3>
        </SurfaceCard>
        <SurfaceCard as="section" labelledBy="b">
          <h3 id="b">Second</h3>
        </SurfaceCard>
      </>,
    );
    expect(screen.getByRole('region', { name: 'First' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Second' })).toBeInTheDocument();
  });

  it('NEGATIVE CONTROL: a third nesting level is reported and clamped', () => {
    expect(MAX_SURFACE_DEPTH).toBe(2);
    // The harness fails a test on any unexpected console.error, so this
    // allowance IS the proof the guard fires: remove the third level and
    // the allowance goes unused; remove the guard and the test below fails.
    (globalThis as { __allowConsole?: (p: RegExp) => void }).__allowConsole?.(
      /SurfaceCard nested 3 levels deep/,
    );
    const { container } = render(
      <SurfaceCard>
        <SurfaceCard level="sunken">
          <SurfaceCard level="sunken">too deep</SurfaceCard>
        </SurfaceCard>
      </SurfaceCard>,
    );
    // Reported…
    const overflowed = container.querySelectorAll('[data-surface-overflow]');
    expect(overflowed).toHaveLength(1);
    // …and clamped rather than fatal: the page still renders.
    expect(screen.getByText('too deep')).toBeInTheDocument();
    const depths = [...container.querySelectorAll('[data-surface-depth]')].map((el) =>
      Number(el.getAttribute('data-surface-depth')),
    );
    expect(Math.max(...depths)).toBe(MAX_SURFACE_DEPTH);
  });

  it('reports nothing and marks nothing at a legal depth', () => {
    const { container } = render(
      <SurfaceCard>
        <SurfaceCard level="sunken">fine</SurfaceCard>
      </SurfaceCard>,
    );
    expect(container.querySelectorAll('[data-surface-overflow]')).toHaveLength(0);
  });
});

describe('Tag', () => {
  it('classifies for assistive tech without relying on colour', () => {
    render(
      <Tag tone="negative" srPrefix="Red flag:">
        Gap in employment
      </Tag>,
    );
    expect(screen.getByText('Red flag:')).toHaveClass('sr-only');
    expect(screen.getByText('Gap in employment')).toBeInTheDocument();
  });

  it('renders every tone with the same high-contrast label ink', () => {
    const tones = ['neutral', 'accent', 'positive', 'caution', 'negative'] as const;
    const { container } = render(
      <>
        {tones.map((tone) => (
          <Tag key={tone} tone={tone}>
            {tone}
          </Tag>
        ))}
      </>,
    );
    const spans = [...container.querySelectorAll('span')].filter((el) =>
      el.className.includes('ring-inset'),
    );
    expect(spans).toHaveLength(tones.length);
    for (const span of spans) {
      expect(span.className).toContain('text-[var(--c-ink-secondary)]');
    }
  });
});

/**
 * Built from parts so Tailwind's content scanner — which reads test files as
 * well as source — never sees a complete arbitrary-value class candidate and
 * emits a dead rule for it into the production bundle.
 */
const TONE_TEXT_UTILITY = 'text-[var(' + '--c-negative' + ')]';
const INK_TEXT_UTILITY = 'text-[var(' + '--c-ink-secondary' + ')]';

describe('CandidateErrorState', () => {
  /**
   * The message is prose on a tinted ground, so it is governed by WCAG 1.4.3's
   * 4.5:1 — and the approved rose reaches only 3.94:1 on its own tint. Tone
   * therefore lives in the border and the fill; the words are ink.
   *
   * A DOM assertion rather than a snapshot: the failure mode is one className
   * on one element, and a snapshot would have been updated alongside it.
   */
  it('paints the message in ink, never in the tone colour', () => {
    render(<CandidateErrorState message="Something went wrong." />);
    const message = screen.getByText('Something went wrong.');
    expect(message.className).toContain(INK_TEXT_UTILITY);
    expect(message.className).not.toContain(TONE_TEXT_UTILITY);
  });

  it('keeps the rose border and tint, so the state is still legible as an error', () => {
    const { container } = render(<CandidateErrorState message="Nope." />);
    const box = container.firstElementChild as HTMLElement;
    expect(box.className).toContain('border-[var(' + '--c-negative' + ')]');
    expect(box.className).toContain('bg-[var(' + '--c-negative-light' + ')]');
  });

  it('still offers a retry only when one is given', () => {
    const { rerender } = render(<CandidateErrorState message="No retry." />);
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
    rerender(<CandidateErrorState message="Retry." onRetry={() => {}} />);
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <CandidateErrorState message="Something went wrong." onRetry={() => {}} />,
    );
    await expect(container).toHaveNoViolations();
  });

  it('the empty state carries no tone colour on its text either', () => {
    render(<CandidateEmptyState title="No candidates yet" hint="Upload a resume." />);
    for (const text of ['No candidates yet', 'Upload a resume.']) {
      expect(screen.getByText(text).className).not.toContain(TONE_TEXT_UTILITY);
    }
  });
});
