import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { anchorClock } from '../../lib/r1/r1-clock';
import { R1RoleplayTimer } from './R1RoleplayTimer';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
});

afterEach(() => {
  vi.useRealTimers();
});

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('the role-play timer', () => {
  it('is a timer, not a live region', () => {
    render(<R1RoleplayTimer clock={anchorClock(480, performance.now())} running />);
    const timer = screen.getByRole('timer');
    expect(timer).toHaveTextContent('Role-play · 8 min left');
    expect(timer).not.toHaveAttribute('aria-live', 'polite');
    expect(timer.closest('[aria-live="polite"]')).toBeNull();
  });

  it('counts down in whole minutes while running, rounding up', () => {
    render(<R1RoleplayTimer clock={anchorClock(121, performance.now())} running />);
    expect(screen.getByRole('timer')).toHaveTextContent('Role-play · 3 min left');
    advance(2_000);
    expect(screen.getByRole('timer')).toHaveTextContent('Role-play · 2 min left');
    advance(60_000);
    expect(screen.getByRole('timer')).toHaveTextContent('Role-play · under a minute left');
  });

  it('says it is wrapping up at zero and never goes negative', () => {
    render(<R1RoleplayTimer clock={anchorClock(3, performance.now())} running />);
    expect(screen.getByRole('timer')).toHaveTextContent('Role-play · under a minute left');
    advance(10_000);
    expect(screen.getByRole('timer')).toHaveTextContent('Role-play · wrapping up');
    advance(600_000);
    expect(screen.getByRole('timer')).toHaveTextContent('Role-play · wrapping up');
  });

  it('holds its value while the role-play is paused, however long that takes', () => {
    render(<R1RoleplayTimer clock={anchorClock(480, performance.now())} running={false} />);
    advance(300_000);
    expect(screen.getByRole('timer')).toHaveTextContent('Role-play · 8 min left');
  });

  it('stops counting the moment it is told the role-play paused', () => {
    const clock = anchorClock(480, performance.now());
    const { rerender } = render(<R1RoleplayTimer clock={clock} running />);
    advance(30_000);
    // The page freezes the clock at its current value as the role-play stops.
    rerender(<R1RoleplayTimer clock={anchorClock(450, performance.now())} running={false} />);
    advance(600_000);
    expect(screen.getByRole('timer')).toHaveTextContent('Role-play · 8 min left');
  });

  it('takes a fresh number from the interviewer over the local count', () => {
    const { rerender } = render(
      <R1RoleplayTimer clock={anchorClock(480, performance.now())} running />,
    );
    advance(60_000);
    expect(screen.getByRole('timer')).toHaveTextContent('Role-play · 7 min left');
    rerender(<R1RoleplayTimer clock={anchorClock(600, performance.now())} running />);
    expect(screen.getByRole('timer')).toHaveTextContent('Role-play · 10 min left');
  });

  it('repaints only when the text changes (once a minute), not on every tick', () => {
    render(<R1RoleplayTimer clock={anchorClock(480, performance.now())} running />);
    const timer = screen.getByRole('timer');
    const observer = new MutationObserver(() => undefined);
    observer.observe(timer, { childList: true, characterData: true, subtree: true });
    // Thirty ticks later the text is the same minute: nothing in the DOM was touched.
    advance(30_000);
    expect(observer.takeRecords()).toHaveLength(0);
    // Past the minute boundary it is repainted.
    advance(31_000);
    expect(observer.takeRecords().length).toBeGreaterThan(0);
    observer.disconnect();
    expect(timer).toHaveTextContent('Role-play · 7 min left');
  });

  it('clears its interval when it goes away', () => {
    const { unmount } = render(<R1RoleplayTimer clock={anchorClock(480, performance.now())} running />);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('has no accessibility violations', async () => {
    vi.useRealTimers();
    const { container } = render(
      <R1RoleplayTimer clock={anchorClock(480, performance.now())} running />,
    );
    await expect(container).toHaveNoViolations();
  });
});
