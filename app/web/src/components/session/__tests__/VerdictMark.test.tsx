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

  it.each([
    ['advance', 'text-ready', 'text-ready-text', 'full'],
    ['hold', 'text-unresolved', 'text-unresolved-text', 'half'],
    ['reject', 'text-closed', 'text-closed-text', 'empty'],
  ])('prints %s in its family: the circle in %s, the word and the figure in %s, the %s shape kept', (value, mark, text, shape) => {
    const { container } = render(<VerdictMark recommendation={value} score={61} />);
    const root = container.querySelector('[data-recommendation]') as HTMLElement;
    const circle = container.querySelector('[data-verdict-mark]') as SVGElement;
    expect(root).toHaveClass(text);
    expect(root).not.toHaveClass('text-ink');
    expect(circle).toHaveClass(mark);
    expect(circle).toHaveAttribute('data-verdict-mark', shape);
    expect(screen.getByText('61')).toHaveClass(text);
  });

  it('takes the colour through currentColor, so index.css can force it in a contrast theme, and is never crimson or orange', () => {
    const { container } = render(<VerdictMark recommendation="reject" score={31} />);
    const circle = container.querySelector('[data-verdict-mark]') as SVGElement;
    expect(circle.innerHTML).toContain('currentColor');
    expect(circle.innerHTML).not.toMatch(/#|rgb|var\(/);
    expect(container.innerHTML).not.toMatch(/danger|error|voice|wash|moving/);
  });

  it.each([
    ['advance', 'Select', 'full'],
    ['hold', 'Borderline', 'half'],
    ['reject', 'Reject', 'empty'],
  ])('prints a %s in ink when asked for no hue, the word and the shape kept', (value, word, shape) => {
    const { container } = render(<VerdictMark recommendation={value} score={80} plain />);
    expect(container.querySelector('[data-recommendation]')).toHaveClass('text-ink');
    expect(container.querySelector('[data-verdict-mark]')).toHaveClass('text-ink');
    expect(container.querySelector('[data-verdict-mark]')).toHaveAttribute('data-verdict-mark', shape);
    expect(screen.getByText(word)).toBeInTheDocument();
    expect(screen.getByText('80')).toHaveClass('text-ink-secondary');
    expect(container.innerHTML).not.toMatch(/ready|unresolved|closed/);
  });

  it.each(['human_review', 'something_new'])('gives %s no hue: no recommendation of its own, no family', (value) => {
    const { container } = render(<VerdictMark recommendation={value} score={50} />);
    expect(container.querySelector('[data-recommendation]')).toHaveClass('text-ink');
    expect(container.innerHTML).not.toMatch(/ready|unresolved|closed/);
    expect(screen.getByText('50')).toHaveClass('text-ink-secondary');
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
