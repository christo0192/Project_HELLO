/**
 * CallStrip: the call drawn to its own scale. What matters here is what each mark claims: a turn is a
 * tick at its start, a bar only where an end was stored (silence is never drawn as talk), and the
 * whole thing reads as text for anyone who cannot see it.
 */
import { createRef } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CallStrip } from '../CallStrip';
import type { CallStripHandle, CallStripProps } from '../CallStrip';
import { assignLanes, axisSteps, snapToTick } from '../call-strip-scale';

function strip(over: Partial<CallStripProps> = {}) {
  const props: CallStripProps = {
    durationSec: 600,
    speakers: [
      { id: 'candidate', label: 'Ava Example', kind: 'candidate', turns: [{ startSec: 60 }, { startSec: 120, endSec: 150 }] },
      { id: 'interviewer', label: 'Christy (AI interviewer)', kind: 'ai', turns: [{ startSec: 0 }] },
    ],
    phases: [{ label: 'Opening', startSec: 0, endSec: 100 }, { label: 'Role-play', startSec: 100, endSec: 600 }],
    markers: [{ sec: 400, label: '14:00', detail: 'Earliest offer to wrap up' }],
    moments: [
      { key: 'q1', sec: 60, kind: 'evidence', number: 1, label: 'Evidence 1, Objection handling, 1:00' },
      { key: 'e1', sec: 300, kind: 'event', label: 'Need 1 revealed, 5:00' },
    ],
    bands: [],
    textAlternative: 'A call of 10:00. Ava Example took 2 turns.',
    onSeek: vi.fn(),
    onMoment: vi.fn(),
    ...over,
  };
  const ref = createRef<CallStripHandle>();
  const view = render(<CallStrip ref={ref} {...props} />);
  return { ...view, props, ref };
}

const leftOf = (el: Element) => (el as HTMLElement).style.left;

describe('what it draws', () => {
  it('draws one row per speaker, and names each', () => {
    strip();
    const group = screen.getByRole('group', { name: 'Call strip' });
    expect(within(group).getByText('Ava Example')).toBeInTheDocument();
    expect(within(group).getByText('Christy (AI interviewer)')).toBeInTheDocument();
  });

  it('draws a tick at the start of each turn, to the scale of the call', () => {
    const { container } = strip();
    const ticks = container.querySelectorAll('[data-speaker="candidate"] [data-turn-tick]');
    expect(ticks).toHaveLength(1);
    expect(leftOf(ticks[0])).toBe('10%');
  });

  it('draws a bar only for a turn with a stored end, never to the next turn', () => {
    const { container } = strip();
    const bars = container.querySelectorAll('[data-speaker="candidate"] [data-talk-bar]');
    expect(bars).toHaveLength(1);
    expect(leftOf(bars[0])).toBe('20%');
    expect((bars[0] as HTMLElement).style.width).toBe('5%');
    expect(container.querySelectorAll('[data-speaker="interviewer"] [data-talk-bar]')).toHaveLength(0);
  });

  it('prints the phases on their ribbon', () => {
    const { container } = strip();
    const segments = container.querySelectorAll('[data-phase]');
    expect([...segments].map((s) => s.textContent)).toEqual(['Opening', 'Role-play']);
    expect((segments[1] as HTMLElement).style.width).toBe(`${(500 / 600) * 100}%`);
  });

  it('marks the lines it is given, in words as well as position', () => {
    const { container } = strip();
    const marker = container.querySelector('[data-marker]') as HTMLElement;
    expect(marker).toHaveTextContent('14:00');
    expect(marker).toHaveAttribute('title', 'Earliest offer to wrap up');
    expect(marker.style.left).toBe(`${(400 / 600) * 100}%`);
  });

  it('prints a band with its word: the outline alone would say nothing', () => {
    const { container } = strip({ bands: [{ startSec: 300, endSec: 600, label: 'Audio only' }] });
    const band = container.querySelector('[data-band]') as HTMLElement;
    expect(band).toHaveTextContent('Audio only');
    expect(band.style.left).toBe('50%');
  });

  it('carries a text alternative', () => {
    strip();
    expect(screen.getByText('A call of 10:00. Ava Example took 2 turns.')).toBeInTheDocument();
  });

  it('draws nothing of a turn past the end of the scale', () => {
    const { container } = strip({ speakers: [{ id: 'x', label: 'X', kind: 'ai', turns: [{ startSec: 900 }] }] });
    expect(leftOf(container.querySelector('[data-turn-tick]')!)).toBe('100%');
  });
});

describe('a reviewer\'s note', () => {
  const noted = { moments: [{ key: 'nabc', sec: 150, kind: 'note' as const, label: 'Note, 2:30' }] };

  it('is a button with a name, at its place on the scale', () => {
    strip(noted);
    const flag = screen.getByRole('button', { name: 'Note, 2:30' });
    expect(flag.style.left).toBe('25%');
    expect(flag).toHaveAttribute('title', 'Note, 2:30');
  });

  it('says its key when pressed', () => {
    const { props } = strip(noted);
    fireEvent.click(screen.getByRole('button', { name: 'Note, 2:30' }));
    expect(props.onMoment).toHaveBeenCalledWith('nabc');
  });

  it('is drawn apart from a quote and a logged moment, so a mark means one thing', () => {
    const { container } = strip({
      moments: [
        { key: 'q1', sec: 60, kind: 'evidence', number: 1, label: 'Evidence 1, Objection handling, 1:00' },
        { key: 'e1', sec: 300, kind: 'event', label: 'Need 1 revealed, 5:00' },
        { key: 'n1', sec: 450, kind: 'note', label: 'Note, 7:30' },
      ],
    });
    expect(container.querySelectorAll('[data-note-flag]')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Note, 7:30' }).querySelector('[data-note-flag]')).not.toBeNull();
    expect(screen.getByRole('button', { name: /^Need 1/ }).querySelector('[data-note-flag]')).toBeNull();
  });

  it('keeps its own row inside a dense cluster, so no box can cover it', () => {
    // 25 minutes on the strip: these four are under 2 px apart, and quotes alone fill the lanes.
    const { container, props } = strip({
      durationSec: 1500,
      moments: [
        { key: 'q1', sec: 125, kind: 'evidence', number: 1, label: 'Evidence 1, Objection handling, 2:05' },
        { key: 'q2', sec: 126, kind: 'evidence', number: 2, label: 'Evidence 2, Objection handling, 2:06' },
        { key: 'n1', sec: 128, kind: 'note', label: 'Note, 2:08' },
        { key: 'q3', sec: 130, kind: 'evidence', number: 3, label: 'Evidence 3, Objection handling, 2:10' },
      ],
    });
    const flag = screen.getByRole('button', { name: 'Note, 2:08' });
    const row = flag.parentElement as HTMLElement;
    expect(row).toHaveAttribute('data-moment-row', 'Notes');
    expect(within(row).getAllByRole('button')).toEqual([flag]);
    expect(container.querySelectorAll('[data-moment-row="Moments"] button')).toHaveLength(3);
    fireEvent.click(flag);
    expect(props.onMoment).toHaveBeenCalledWith('n1');
  });

  it('adds no Notes row to a strip with no notes, and no Moments row to one with only notes', () => {
    const { container, unmount } = strip();
    expect(container.querySelector('[data-moment-row="Notes"]')).toBeNull();
    expect(screen.queryByText('Notes')).toBeNull();
    unmount();
    const only = strip(noted);
    expect(only.container.querySelector('[data-moment-row="Moments"]')).toBeNull();
    expect(screen.getByText('Notes')).toBeInTheDocument();
  });

  it('stacks notes that sit close together, each in a lane of the row', () => {
    const { container } = strip({
      durationSec: 1500,
      moments: [
        { key: 'n1', sec: 120, kind: 'note', label: 'Note, 2:00' },
        { key: 'n2', sec: 121, kind: 'note', label: 'Note, 2:01' },
      ],
    });
    const tops = [...container.querySelectorAll<HTMLElement>('[data-moment-row="Notes"] button')].map((flag) => flag.style.top);
    expect(new Set(tops).size).toBe(2);
    expect((container.querySelector('[data-moment-row="Notes"]') as HTMLElement).style.height).toBe('40px');
  });

  it('survives forced colours: a flag is fills, so each carries the mark', () => {
    const { container } = strip(noted);
    const flag = container.querySelector('[data-note-flag]') as HTMLElement;
    expect(flag.querySelectorAll('[data-mark]').length).toBeGreaterThan(0);
  });

  it('uses no colour of its own: orange is the candidate\'s, and the wash is for quotes', () => {
    const { container } = strip(noted);
    const flag = container.querySelector('[data-note-flag]') as HTMLElement;
    expect(flag.outerHTML).not.toMatch(/voice|wash|danger/);
  });
});

describe('hiding the speakers', () => {
  it('collapses the speaker rows and keeps the ribbon and the moments', () => {
    const { container } = strip();
    fireEvent.click(screen.getByRole('button', { name: 'Hide speakers' }));
    expect(container.querySelector('[data-speaker]')).toBeNull();
    expect(container.querySelector('[data-phase]')).not.toBeNull();
    expect(screen.getByRole('button', { name: /^Evidence 1/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show speakers' }));
    expect(container.querySelector('[data-speaker]')).not.toBeNull();
  });
});

describe('moving through the call', () => {
  const rail = () => screen.getByRole('slider', { name: 'Position in the recording' });
  const sized = (el: HTMLElement) => {
    el.getBoundingClientRect = () => ({ left: 100, width: 600, top: 0, height: 10, right: 700, bottom: 10, x: 100, y: 0, toJSON: () => ({}) });
  };

  it('seeks where the rail is pressed', () => {
    const { props } = strip({ speakers: [] });
    sized(rail());
    fireEvent.click(rail(), { clientX: 400 });
    expect(props.onSeek).toHaveBeenCalledWith(300);
  });

  it('lands on a turn pressed within a few pixels: a tick is one pixel wide', () => {
    const { props } = strip();
    sized(rail());
    fireEvent.click(rail(), { clientX: 162 });
    expect(props.onSeek).toHaveBeenCalledWith(60);
  });

  it('steps with the arrow keys, and goes to either end with Home and End', () => {
    const { props, ref } = strip();
    ref.current!.movePlayhead(100);
    fireEvent.keyDown(rail(), { key: 'ArrowRight' });
    expect(props.onSeek).toHaveBeenLastCalledWith(105);
    fireEvent.keyDown(rail(), { key: 'ArrowLeft' });
    expect(props.onSeek).toHaveBeenLastCalledWith(95);
    fireEvent.keyDown(rail(), { key: 'Home' });
    expect(props.onSeek).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(rail(), { key: 'End' });
    expect(props.onSeek).toHaveBeenLastCalledWith(600);
  });

  it('never steps past either end', () => {
    const { props, ref } = strip();
    ref.current!.movePlayhead(598);
    fireEvent.keyDown(rail(), { key: 'ArrowRight' });
    expect(props.onSeek).toHaveBeenLastCalledWith(600);
  });

  it('lets a phase and a marker answer the pointer, so their tooltips can show, and seeks from them', () => {
    const { container, props } = strip();
    sized(rail());
    const phase = container.querySelector('[data-phase]') as HTMLElement;
    const marker = container.querySelector('[data-marker]') as HTMLElement;
    for (const mark of [phase, marker]) expect(mark).toHaveClass('pointer-events-auto');
    fireEvent.click(phase, { clientX: 400 });
    expect(props.onSeek).toHaveBeenLastCalledWith(300);
    fireEvent.click(marker, { clientX: 500 });
    expect(props.onSeek).toHaveBeenLastCalledWith(400);
  });

  it('opens a moment from its own button, by name', () => {
    const { props } = strip();
    fireEvent.click(screen.getByRole('button', { name: 'Need 1 revealed, 5:00' }));
    expect(props.onMoment).toHaveBeenCalledWith('e1');
    expect(props.onSeek).not.toHaveBeenCalled();
  });

  it('moves the playhead without rendering, and reports the time to assistive technology', () => {
    const { container, ref } = strip();
    ref.current!.movePlayhead(150);
    expect((container.querySelector('[data-playhead]') as HTMLElement).style.left).toBe('25%');
    expect(rail()).toHaveAttribute('aria-valuenow', '150');
    expect(rail()).toHaveAttribute('aria-valuetext', '2:30');
  });

  it('starts at the position it is given', () => {
    const { container } = strip({ initialSec: 300 });
    expect((container.querySelector('[data-playhead]') as HTMLElement).style.left).toBe('50%');
  });
});

describe('the small rules', () => {
  it('snaps to a tick within the tolerance, and only then', () => {
    expect(snapToTick(61, [60, 120], 2)).toBe(60);
    expect(snapToTick(65, [60, 120], 2)).toBe(65);
    expect(snapToTick(65, [], 2)).toBe(65);
  });

  it('keeps moments from overlapping by moving the later one to a new lane', () => {
    expect(assignLanes([10, 11, 12, 50], 600, 20)).toEqual([0, 1, 2, 0]);
    expect(assignLanes([], 600, 20)).toEqual([]);
  });

  it('labels the axis in a step that stays readable', () => {
    expect(axisSteps(600)).toEqual([0, 120, 240, 360, 480, 600]);
    expect(axisSteps(1800)).toEqual([0, 300, 600, 900, 1200, 1500, 1800]);
    expect(axisSteps(45)).toEqual([0]);
  });
});
