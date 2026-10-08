import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { R1Caption } from '../../lib/r1/r1-phase';
import { R1Captions } from './R1Captions';

function lines(count: number, final = true): R1Caption[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `c${index + 1}`,
    text: `Caption number ${index + 1}.`,
    final,
    speaker: 'interviewer' as const,
  }));
}

/**
 * jsdom has no layout, so the scroll geometry of the log is faked on the element: a content
 * height, a viewport height and a `scrollTop` that clamps the way a browser's does.
 */
function fakeGeometry(log: HTMLElement, geometry: { scrollHeight: number; clientHeight: number }) {
  const state = { top: 0 };
  Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => geometry.scrollHeight });
  Object.defineProperty(log, 'clientHeight', { configurable: true, get: () => geometry.clientHeight });
  Object.defineProperty(log, 'scrollTop', {
    configurable: true,
    get: () => state.top,
    set: (value: number) => {
      state.top = Math.max(0, Math.min(value, geometry.scrollHeight - geometry.clientHeight));
    },
  });
  return {
    geometry,
    get top() {
      return state.top;
    },
    /** The reader drags the scrollbar: set the position and let the component hear about it. */
    scrollTo(top: number) {
      state.top = top;
      fireEvent.scroll(log);
    },
  };
}

describe('R1Captions log', () => {
  it('waits quietly before the first line', () => {
    render(<R1Captions captions={[]} />);
    expect(screen.getByText('Listening for the interviewer…')).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('is a labelled, keyboard-scrollable log inside the Live captions region', () => {
    render(<R1Captions captions={lines(50)} />);
    const region = screen.getByRole('region', { name: 'Live captions' });
    const log = screen.getByRole('log', { name: 'Transcript' });
    expect(region).toContainElement(log);
    // Without a tab stop a keyboard user cannot scroll it (axe: scrollable-region-focusable).
    expect(log).toHaveAttribute('tabindex', '0');
    expect(log.querySelectorAll('.candidate-caption')).toHaveLength(50);
  });

  it('announces additions only, never the whole log again', () => {
    render(<R1Captions captions={lines(3)} />);
    const log = screen.getByRole('log');
    expect(log).toHaveAttribute('aria-live', 'polite');
    expect(log).toHaveAttribute('aria-relevant', 'additions');
  });

  it('keeps each caption in the page once, so nothing is read twice', () => {
    render(<R1Captions captions={lines(2)} />);
    expect(screen.getAllByText('Caption number 2.')).toHaveLength(1);
  });

  it('labels the speaker on every line', () => {
    render(
      <R1Captions
        captions={[
          { id: 'a', text: 'Tell me about yourself.', final: true, speaker: 'interviewer' },
          { id: 'b', text: 'Hello? Yes, this is Meera.', final: true, speaker: 'learner' },
        ]}
      />,
    );
    const region = screen.getByRole('region', { name: 'Live captions' });
    expect(region).toHaveTextContent('Interviewer');
    expect(region).toHaveTextContent('Learner (simulated by the AI)');
  });
});

describe('R1Captions announcements', () => {
  it('hides a line that is still being spoken and exposes it once it is final', () => {
    const interim: R1Caption = { id: 'x', text: 'Could you walk', final: false, speaker: 'interviewer' };
    const { rerender } = render(<R1Captions captions={[interim]} />);
    expect(screen.getByText('Could you walk').closest('p')).toHaveAttribute('aria-hidden', 'true');

    rerender(<R1Captions captions={[{ ...interim, text: 'Could you walk me through it?', final: true }]} />);
    const done = screen.getByText('Could you walk me through it?').closest('p');
    expect(done).not.toHaveAttribute('aria-hidden');
  });

  it('turns a line final as a fresh addition, and grows an interim line in place', () => {
    const base: R1Caption = { id: 'x', text: 'Could you', final: false, speaker: 'interviewer' };
    const { rerender } = render(<R1Captions captions={[base]} />);
    const first = screen.getByText('Could you').closest('p');

    // Interim growth is an in-place text change: with `aria-relevant="additions"` it is not read.
    rerender(<R1Captions captions={[{ ...base, text: 'Could you walk me through' }]} />);
    expect(screen.getByText('Could you walk me through').closest('p')).toBe(first);

    // Finalising mounts one new node: that single addition is what a screen reader reads.
    rerender(<R1Captions captions={[{ ...base, text: 'Could you walk me through it?', final: true }]} />);
    const finalNode = screen.getByText('Could you walk me through it?').closest('p');
    expect(finalNode).not.toBe(first);
    expect(first?.isConnected).toBe(false);
  });
});

describe('R1Captions scrolling', () => {
  it('follows the newest line while the reader is at the end', () => {
    const { rerender } = render(<R1Captions captions={lines(40)} />);
    const log = screen.getByRole('log');
    const scroll = fakeGeometry(log, { scrollHeight: 2000, clientHeight: 300 });

    rerender(<R1Captions captions={lines(41)} />);
    expect(scroll.top).toBe(1700);

    // A line that grows after it arrived keeps the reader on it too.
    scroll.geometry.scrollHeight = 2100;
    rerender(<R1Captions captions={lines(41)} />);
    expect(scroll.top).toBe(1800);
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
  });

  it('does not mistake its own late scroll event for the reader leaving, when the box shrank meanwhile', () => {
    const { rerender } = render(<R1Captions captions={lines(40)} />);
    const log = screen.getByRole('log');
    const scroll = fakeGeometry(log, { scrollHeight: 2000, clientHeight: 300 });
    rerender(<R1Captions captions={lines(40)} />);
    expect(scroll.top).toBe(1700);

    // The scenario card appears and the list gets shorter; only then does the browser report
    // the scroll the component made a moment ago. The position is still the one it set.
    scroll.geometry.clientHeight = 100;
    fireEvent.scroll(log);
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();

    // Still following: the next line lands the reader on the end of the shorter list.
    scroll.geometry.scrollHeight = 2080;
    rerender(<R1Captions captions={lines(41)} />);
    expect(scroll.top).toBe(1980);
  });

  it('holds the position once the reader scrolls up, and counts what they have not seen', () => {
    const { rerender } = render(<R1Captions captions={lines(40)} />);
    const log = screen.getByRole('log');
    const scroll = fakeGeometry(log, { scrollHeight: 2000, clientHeight: 300 });
    rerender(<R1Captions captions={lines(40)} />);
    expect(scroll.top).toBe(1700);
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();

    scroll.scrollTo(200);
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeVisible();

    scroll.geometry.scrollHeight = 2080;
    rerender(<R1Captions captions={lines(41)} />);
    expect(scroll.top).toBe(200);
    expect(screen.getByRole('button', { name: 'Jump to latest (1 new)' })).toBeVisible();

    scroll.geometry.scrollHeight = 2160;
    rerender(<R1Captions captions={lines(42)} />);
    expect(scroll.top).toBe(200);
    expect(screen.getByRole('button', { name: 'Jump to latest (2 new)' })).toBeVisible();
  });

  it('does not count a line that is only growing as new', () => {
    const { rerender } = render(<R1Captions captions={lines(40)} />);
    const log = screen.getByRole('log');
    const scroll = fakeGeometry(log, { scrollHeight: 2000, clientHeight: 300 });
    rerender(<R1Captions captions={lines(40)} />);
    scroll.scrollTo(0);

    const grown = lines(40);
    grown[39] = { ...grown[39], text: 'Caption number 40, and then some more.' };
    rerender(<R1Captions captions={grown} />);
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
  });

  it('re-pins on Jump to latest, hides the button and hands focus to the log', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<R1Captions captions={lines(40)} />);
    const log = screen.getByRole('log');
    const scroll = fakeGeometry(log, { scrollHeight: 2000, clientHeight: 300 });
    rerender(<R1Captions captions={lines(40)} />);
    scroll.scrollTo(0);
    scroll.geometry.scrollHeight = 2080;
    rerender(<R1Captions captions={lines(41)} />);

    await user.click(screen.getByRole('button', { name: 'Jump to latest (1 new)' }));
    expect(scroll.top).toBe(1780);
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
    // The button just left the page: the keyboard must not fall back to <body>.
    expect(log).toHaveFocus();

    // And it is following again.
    scroll.geometry.scrollHeight = 2160;
    rerender(<R1Captions captions={lines(42)} />);
    expect(scroll.top).toBe(1860);
  });

  it('can be reached and used from the keyboard', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<R1Captions captions={lines(40)} />);
    const log = screen.getByRole('log');
    const scroll = fakeGeometry(log, { scrollHeight: 2000, clientHeight: 300 });
    rerender(<R1Captions captions={lines(40)} />);
    scroll.scrollTo(0);

    await user.tab();
    expect(log).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(log).toHaveFocus();
    expect(scroll.top).toBe(1700);
  });

  it('drops the button when the reader scrolls back to the end by hand', () => {
    const { rerender } = render(<R1Captions captions={lines(40)} />);
    const log = screen.getByRole('log');
    const scroll = fakeGeometry(log, { scrollHeight: 2000, clientHeight: 300 });
    rerender(<R1Captions captions={lines(40)} />);
    scroll.scrollTo(0);
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeVisible();

    // Within one line of the end counts as the end.
    scroll.scrollTo(1700 - 30);
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();

    scroll.geometry.scrollHeight = 2080;
    rerender(<R1Captions captions={lines(41)} />);
    expect(scroll.top).toBe(1780);
  });

  it('counts every line as new when the line the reader left on has aged out of the list', () => {
    const { rerender } = render(<R1Captions captions={lines(5)} />);
    const log = screen.getByRole('log');
    const scroll = fakeGeometry(log, { scrollHeight: 2000, clientHeight: 300 });
    rerender(<R1Captions captions={lines(5)} />);
    scroll.scrollTo(0);

    const later = Array.from({ length: 3 }, (_, index) => ({
      id: `z${index}`,
      text: `Later ${index}`,
      final: true,
      speaker: 'interviewer' as const,
    }));
    rerender(<R1Captions captions={later} />);
    expect(screen.getByRole('button', { name: 'Jump to latest (3 new)' })).toBeVisible();
  });
});

describe('R1Captions accessibility', () => {
  it('has no violations with a long log and the jump button showing', async () => {
    const { container, rerender } = render(<R1Captions captions={lines(50)} />);
    const log = screen.getByRole('log');
    const scroll = fakeGeometry(log, { scrollHeight: 4000, clientHeight: 300 });
    rerender(<R1Captions captions={lines(50)} />);
    scroll.scrollTo(0);
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
    await expect(container).toHaveNoViolations();
  });
});
