import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VerdictMark } from '../VerdictMark';

describe('VerdictMark', () => {
  it.each([
    ['advance', 'Select', 'full'],
    ['hold', 'Borderline', 'half'],
    ['reject', 'Reject', 'empty'],
  ])('prints %s as the word %s beside a %s circle', (value, word, fill) => {
    const { container } = render(<VerdictMark recommendation={value} />);
    expect(screen.getByText(word)).toBeInTheDocument();
    expect(container.querySelector('[data-verdict-mark]')).toHaveAttribute('data-verdict-mark', fill);
    // The stored value stays the hook; the word is what a reader gets.
    expect(container.querySelector('[data-recommendation]')).toHaveAttribute('data-recommendation', value);
  });

  it('draws the circle in ink, never a hue', () => {
    const { container } = render(<VerdictMark recommendation="reject" />);
    const mark = container.querySelector('[data-verdict-mark]') as SVGElement;
    expect(mark.getAttribute('class')).toContain('text-ink');
    expect(mark.innerHTML).not.toMatch(/#|rgb|var\(--danger|var\(--voice/);
  });

  it.each([
    ['md', 'text-label', 'font-medium', 'h-3'],
    ['lg', 'text-sm', 'font-medium', 'h-3.5'],
    ['xl', 'text-xl', 'font-semibold', 'h-4'],
  ] as const)('sets %s in its own size, the word and the circle together', (size, text, weight, height) => {
    const { container } = render(<VerdictMark recommendation="hold" size={size} />);
    expect(container.querySelector('[data-recommendation]')).toHaveClass(text, weight);
    expect(container.querySelector('[data-verdict-mark]')).toHaveClass(height);
  });

  it('is decoration only: the name comes from the word', () => {
    const { container } = render(<VerdictMark recommendation="hold" score={61} />);
    expect(container.querySelector('[data-verdict-mark]')).toHaveAttribute('aria-hidden', 'true');
    expect(container.textContent).toBe('Borderline61');
  });

  it('never prints a zero for a missing score', () => {
    const { container } = render(<VerdictMark recommendation="hold" score={null} />);
    expect(container.textContent).toBe('Borderline');
  });

  it('prints a score of zero when zero was scored', () => {
    const { container } = render(<VerdictMark recommendation="reject" score={0} />);
    expect(container.textContent).toBe('Reject0');
  });

  it('keeps the word for a verdict that has no position, without inventing a mark', () => {
    const { container } = render(<VerdictMark recommendation="human_review" />);
    expect(container.querySelector('[data-verdict-mark]')).toBeNull();
    expect(container.textContent).not.toBe('');
  });

  it('renders nothing when there is no verdict', () => {
    const { container } = render(<VerdictMark recommendation={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
