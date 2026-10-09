import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/**
 * jsdom has no ResizeObserver. This one records what is observed and reports a resize of one
 * element on demand, to the observers that watch it, the way a browser does after layout.
 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];

  readonly targets = new Set<Element>();

  readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
  }

  static resize(target: Element): void {
    for (const observer of FakeResizeObserver.instances) {
      if (observer.targets.has(target)) {
        observer.callback(
          [{ target } as ResizeObserverEntry],
          observer as unknown as ResizeObserver,
        );
      }
    }
  }
}

describe('R1Captions when the list changes size', () => {
  beforeEach(() => {
    FakeResizeObserver.instances = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A pinned list on forty lines, with its geometry faked. */
  function pinnedList() {
    const current = lines(40);
    const view = render(<R1Captions captions={current} />);
    const log = screen.getByRole('log');
    const scroll = fakeGeometry(log, { scrollHeight: 2000, clientHeight: 300 });
    view.rerender(<R1Captions captions={lines(40)} />);
    expect(scroll.top).toBe(1700);
    return { ...view, log, scroll, content: log.firstElementChild as HTMLElement };
  }

  it('watches the list and the box its lines are in', () => {
    const { log, content, unmount } = pinnedList();
    expect(content).toHaveClass('r1-captions__content');
    expect(content.querySelectorAll('.candidate-caption')).toHaveLength(40);
    const watched = new Set(FakeResizeObserver.instances.flatMap((observer) => [...observer.targets]));
    expect(watched).toEqual(new Set([log, content]));
    unmount();
    expect(FakeResizeObserver.instances.every((observer) => observer.targets.size === 0)).toBe(true);
  });

  it('stays on the newest line when a parent re-render shrinks the list, before any observer reports it', () => {
    const { rerender, scroll } = pinnedList();
    // The scenario card grows to its briefing form and takes 150 px from the list. The captions
    // are the very same array: only the box around them changed, in the commit of the parent.
    const same = lines(40);
    rerender(<R1Captions captions={same} />);
    scroll.geometry.clientHeight = 150;
    rerender(<R1Captions captions={same} />);
    expect(scroll.top).toBe(1850);
  });

  it('stays on the newest line when the list box shrinks and the observer reports it', () => {
    const { log, scroll } = pinnedList();
    scroll.geometry.clientHeight = 100;
    FakeResizeObserver.resize(log);
    expect(scroll.top).toBe(1900);
  });

  it('stays on the newest line when the lines re-wrap inside a list that keeps its size', () => {
    const { scroll, content } = pinnedList();
    // The web font arrives: every line is a little wider, so the content is 400 px taller. The
    // list box is the same height and there is no new caption, so only the content's own resize
    // can tell the component.
    scroll.geometry.scrollHeight = 2400;
    FakeResizeObserver.resize(content);
    expect(scroll.top).toBe(2100);
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
  });

  it('holds a reader who scrolled up in place through every one of those changes', () => {
    const { rerender, log, scroll, content } = pinnedList();
    scroll.scrollTo(200);
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeVisible();

    const same = lines(40);
    scroll.geometry.clientHeight = 150;
    rerender(<R1Captions captions={same} />);
    FakeResizeObserver.resize(log);
    scroll.geometry.scrollHeight = 2400;
    FakeResizeObserver.resize(content);
    rerender(<R1Captions captions={same} />);

    expect(scroll.top).toBe(200);
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeVisible();

    // And the way back still works, onto the newest line of the list as it is now.
    scroll.geometry.scrollHeight = 2480;
    rerender(<R1Captions captions={lines(41)} />);
    expect(scroll.top).toBe(200);
    expect(screen.getByRole('button', { name: 'Jump to latest (1 new)' })).toBeVisible();
  });

  it('does not move a reader who has begun to scroll up when something unrelated renders or the list reports the size it already has', () => {
    const { rerender, log, scroll, content } = pinnedList();

    // The first moments of a keyboard, smooth-wheel or trackpad scroll: the reader is 20 px up,
    // still inside the 48 px that counts as the end, so the component has not (and should not
    // yet) treat them as having left.
    scroll.scrollTo(1700 - 20);
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();

    // Unrelated commits: the interviewer's level meter re-renders the live view several times a
    // second, and the 30 s role-play heartbeat re-renders it too. The captions and the box they
    // are in are exactly as they were.
    const same = lines(40);
    rerender(<R1Captions captions={same} />);
    rerender(<R1Captions captions={same} />);
    rerender(<R1Captions captions={lines(40)} />);
    expect(scroll.top, 'a commit that changed nothing about the list moved the reader').toBe(1680);

    // An observer callback for a size that was already dealt with (the one that follows our own
    // pin, a frame after the commit) must not move them either.
    FakeResizeObserver.resize(log);
    FakeResizeObserver.resize(content);
    expect(scroll.top, 'an observer report of the same size moved the reader').toBe(1680);

    // The reader carries on, and now they have left: the position is held, the way back offered.
    scroll.scrollTo(1700 - 80);
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
    rerender(<R1Captions captions={same} />);
    expect(scroll.top).toBe(1620);
  });

  it('still catches a reader within a line of the end up with a line that arrives', () => {
    const { rerender, scroll } = pinnedList();
    scroll.scrollTo(1700 - 20);
    rerender(<R1Captions captions={lines(40)} />);
    expect(scroll.top).toBe(1680);

    // The list did change size this time: a line arrived. Within a line of the end is "reading
    // the latest", so they are taken to it.
    scroll.geometry.scrollHeight = 2080;
    rerender(<R1Captions captions={lines(41)} />);
    expect(scroll.top).toBe(1780);
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
  });

  it('re-pins once for one change of size, however many commits and reports follow it', () => {
    const { rerender, log, scroll, content } = pinnedList();
    scroll.geometry.clientHeight = 150;
    rerender(<R1Captions captions={lines(40)} />);
    expect(scroll.top).toBe(1850);

    // The reader nudges up 20 px; the observer reports the change of size that the commit has
    // already handled, then the level meter renders: neither takes the nudge back.
    scroll.scrollTo(1850 - 20);
    FakeResizeObserver.resize(log);
    FakeResizeObserver.resize(content);
    rerender(<R1Captions captions={lines(40)} />);
    expect(scroll.top).toBe(1830);
  });

  it('follows again after the reader returns to the end, through the next resize', () => {
    const { rerender, log, scroll } = pinnedList();
    scroll.scrollTo(0);
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
    scroll.scrollTo(1700);
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();

    scroll.geometry.clientHeight = 120;
    FakeResizeObserver.resize(log);
    expect(scroll.top).toBe(1880);
    rerender(<R1Captions captions={lines(40)} />);
    expect(scroll.top).toBe(1880);
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
