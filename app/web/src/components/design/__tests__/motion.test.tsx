/**
 * Motion lib: reduced-motion hook + count-up gate.
 */
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  useReducedMotion,
  useCountUp,
  usePageVariants,
  EASE_EMPHASIZED,
} from '../../../lib/motion';
import { stubMatchMedia } from './helpers';

function ReducedProbe() {
  const reduced = useReducedMotion();
  return <span data-testid="reduced">{String(reduced)}</span>;
}

function CountUpProbe({ target, disabled }: { target: number; disabled?: boolean }) {
  const value = useCountUp(target, { disabled });
  return <span data-testid="value">{value}</span>;
}

function PageVariantsProbe() {
  const variants = usePageVariants();
  const initial = variants.initial as { y?: number } | undefined;
  return <span data-testid="initial">{String(initial?.y ?? 0)}</span>;
}

describe('useReducedMotion', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns false when matchMedia is unavailable', () => {
    render(<ReducedProbe />);
    expect(screen.getByTestId('reduced')).toHaveTextContent('false');
  });

  it('returns true when the OS requests reduced motion', () => {
    stubMatchMedia(true, '(prefers-reduced-motion: reduce)');
    render(<ReducedProbe />);
    expect(screen.getByTestId('reduced')).toHaveTextContent('true');
  });

  it('reacts to OS changes at runtime', () => {
    const stub = stubMatchMedia(false, '(prefers-reduced-motion: reduce)');
    render(<ReducedProbe />);
    expect(screen.getByTestId('reduced')).toHaveTextContent('false');
    act(() => {
      stub.setMatches(true);
    });
    expect(screen.getByTestId('reduced')).toHaveTextContent('true');
  });
});

describe('useCountUp', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the target immediately when disabled (reduced motion)', () => {
    stubMatchMedia(true, '(prefers-reduced-motion: reduce)');
    render(<CountUpProbe target={42} disabled />);
    expect(screen.getByTestId('value')).toHaveTextContent('42');
  });

  it('starts at zero and animates to the target when enabled', () => {
    render(<CountUpProbe target={100} />);
    // Initial frame renders the count-up start value.
    expect(Number(screen.getByTestId('value').textContent)).toBeGreaterThanOrEqual(0);
    expect(Number(screen.getByTestId('value').textContent)).toBeLessThanOrEqual(100);
  });
});

describe('usePageVariants', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('collapses to static (y=0) variants under reduced motion', () => {
    stubMatchMedia(true, '(prefers-reduced-motion: reduce)');
    render(<PageVariantsProbe />);
    expect(screen.getByTestId('initial')).toHaveTextContent('0');
  });

  it('keeps the animated y offset by default', () => {
    render(<PageVariantsProbe />);
    expect(screen.getByTestId('initial')).toHaveTextContent('8');
  });
});

describe('easing constants', () => {
  it('exposes the bklit-adapted emphasized ease', () => {
    expect(EASE_EMPHASIZED).toEqual([0.85, 0, 0.15, 1]);
  });
});
