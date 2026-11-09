/**
 * The strip as a picture and a set of controls: heights, marks, ticks and the words for it. The
 * arithmetic behind it is in callStripGeometry.test.ts.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReviewCallStrip } from '../ReviewCallStrip';
import type { ReviewCallStripProps } from '../ReviewCallStrip';

const PROPS: ReviewCallStripProps = {
  segments: [
    { kind: 'gate', startSec: 0, endSec: 10 },
    { kind: 'ai', startSec: 20, endSec: 30 },
    { kind: 'candidate', startSec: 40, endSec: 60 },
  ],
  endSec: 100,
  drops: [{ fromSec: 70, toSec: 90 }],
  ticks: [{ number: 1, sec: 40, label: 'Evidence 1: turn 3 at 00:40, Rapport' }],
  alternative: 'Call strip: 1 min 40 s. 1 evidence quote.',
};

const segment = (kind: string) => document.querySelector<SVGRectElement>(`[data-strip-segment="${kind}"]`)!;

describe('ReviewCallStrip', () => {
  it('stands the candidate at full height and the interviewer at a third of it', () => {
    render(<ReviewCallStrip {...PROPS} />);
    expect(segment('candidate')).toHaveAttribute('height', '24');
    expect(segment('candidate')).toHaveAttribute('y', '0');
    expect(segment('ai')).toHaveAttribute('height', '8');
    expect(segment('ai')).toHaveAttribute('y', '8');
  });

  it('places a segment by its share of the call', () => {
    render(<ReviewCallStrip {...PROPS} />);
    expect(segment('candidate')).toHaveAttribute('x', '40%');
    expect(segment('candidate')).toHaveAttribute('width', '20%');
  });

  it('colours by the tokens, hatches the gate, and draws the drop dotted', () => {
    render(<ReviewCallStrip {...PROPS} />);
    expect(segment('candidate')).toHaveAttribute('fill', 'var(--voice-mark)');
    expect(segment('ai')).toHaveAttribute('fill', 'var(--ai)');
    expect(segment('gate').getAttribute('fill')).toMatch(/^url\(#hatch-/);
    const drop = document.querySelector('[data-strip-drop]')!;
    expect(drop).toHaveAttribute('x1', '70%');
    expect(drop).toHaveAttribute('x2', '90%');
    expect(drop).toHaveAttribute('stroke-dasharray', '1.5 3');
  });

  it('starts a drop nobody saw at the last talk before the reconnect', () => {
    render(<ReviewCallStrip {...PROPS} drops={[{ fromSec: null, toSec: 90 }]} />);
    expect(document.querySelector('[data-strip-drop]')).toHaveAttribute('x1', '60%');
  });

  it('is one image in words, with its ticks as real buttons', () => {
    const onTick = vi.fn();
    render(<ReviewCallStrip {...PROPS} onTick={onTick} activeTick={1} />);
    expect(screen.getByRole('img')).toHaveAccessibleName('Call strip: 1 min 40 s. 1 evidence quote.');
    const tick = screen.getByRole('button', { name: 'Evidence 1: turn 3 at 00:40, Rapport' });
    expect(tick).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(tick);
    expect(onTick).toHaveBeenCalledWith(1);
  });

  describe('a quiet tick', () => {
    const quiet = [{ ...PROPS.ticks![0], family: 'ready' as const, quiet: true }];
    const box = () => screen.getByRole('button', { name: 'Evidence 1: turn 3 at 00:40, Rapport' });
    const stem = () => document.querySelector('[data-tick-stem="1"]')!;

    it('has a faint edge and a lighter line, and keeps its digit', () => {
      render(<ReviewCallStrip {...PROPS} ticks={quiet} />);
      expect(box()).toHaveClass('border-rule', 'text-ready-text');
      expect(box()).not.toHaveClass('border-ready');
      expect(stem()).toHaveClass('bg-control');
      expect(stem()).not.toHaveClass('bg-ink');
    });

    it('keeps its place, its name and its press', () => {
      const onTick = vi.fn();
      const { rerender } = render(<ReviewCallStrip {...PROPS} ticks={[{ ...quiet[0], quiet: false }]} onTick={onTick} />);
      const [left, stemLeft] = [box().style.left, stem().getAttribute('style')];
      rerender(<ReviewCallStrip {...PROPS} ticks={quiet} onTick={onTick} />);
      expect(box().style.left).toBe(left);
      expect(stem().getAttribute('style')).toBe(stemLeft);
      fireEvent.click(box());
      expect(onTick).toHaveBeenCalledWith(1);
    });

    it('stands at full weight while it is pressed', () => {
      render(<ReviewCallStrip {...PROPS} ticks={quiet} activeTick={1} />);
      expect(box()).toHaveClass('border-ready-text', 'bg-ready-text', 'text-paper');
      expect(stem()).toHaveClass('bg-ink');
    });
  });

  it.each([
    ['ready', 'border-ready bg-paper text-ready-text', 'border-ready-text bg-ready-text text-paper'],
    ['unresolved', 'border-unresolved bg-paper text-unresolved-text', 'border-unresolved-text bg-unresolved-text text-paper'],
    ['closed', 'border-closed bg-paper text-closed-text', 'border-closed-text bg-closed-text text-paper'],
    [null, 'border-ink bg-paper text-ink', 'border-ink bg-ink text-paper'],
  ] as const)('prints a tick of a %s rating in its family, resting and pressed', (family, resting, pressed) => {
    const ticks = [{ ...PROPS.ticks![0], family }];
    const { rerender } = render(<ReviewCallStrip {...PROPS} ticks={ticks} />);
    const tick = screen.getByRole('button', { name: /^Evidence 1/ });
    expect(tick).toHaveClass(...resting.split(' '), 'hover:bg-field');
    rerender(<ReviewCallStrip {...PROPS} ticks={ticks} activeTick={1} />);
    expect(tick).toHaveClass(...pressed.split(' '));
    expect(tick).not.toHaveClass('hover:bg-field');
  });

  it('keeps a tick its stem in ink, so it reads across the voice mark', () => {
    render(<ReviewCallStrip {...PROPS} ticks={[{ ...PROPS.ticks![0], family: 'closed' }]} />);
    expect(document.querySelector('.bg-ink.w-px')).not.toBeNull();
  });

  it('draws a playhead only when there is a position, on the same scale', () => {
    const { rerender } = render(<ReviewCallStrip {...PROPS} />);
    expect(document.querySelector('[data-playhead]')).toBeNull();
    rerender(<ReviewCallStrip {...PROPS} positionSec={25} />);
    expect(document.querySelector<HTMLElement>('[data-playhead]')!.style.left).toBe('25%');
  });

  it('has no break on an ordinary reconnect', () => {
    render(<ReviewCallStrip {...PROPS} />);
    expect(document.querySelector('[data-strip-break]')).toBeNull();
  });

  it('leaves a gap no drop explains as bare paper, and still cuts one too long to draw', () => {
    render(
      <ReviewCallStrip
        {...PROPS}
        segments={[
          { kind: 'candidate', startSec: 0, endSec: 480 },
          { kind: 'ai', startSec: 86_400, endSec: 86_520 },
        ]}
        endSec={86_520}
        drops={[]}
        gaps={[{ fromSec: 480, toSec: 86_400 }]}
        ticks={[]}
      />,
    );
    expect(document.querySelector('[data-strip-drop]')).toBeNull();
    expect(document.querySelectorAll('[data-strip-break]')).toHaveLength(1);
    expect(parseFloat(segment('candidate').getAttribute('width')!)).toBeGreaterThan(70);
  });

  it('breaks a next-day reconnect instead of squeezing the talk, and keeps its marks readable', () => {
    const marks = () => [...document.querySelectorAll('[data-call-strip] [aria-hidden="true"].font-mono > span')];
    render(
      <ReviewCallStrip
        {...PROPS}
        segments={[
          { kind: 'candidate', startSec: 0, endSec: 480 },
          { kind: 'ai', startSec: 86_400, endSec: 86_520 },
        ]}
        endSec={86_520}
        drops={[{ fromSec: 480, toSec: 86_400 }]}
        ticks={[]}
      />,
    );
    expect(document.querySelectorAll('[data-strip-break]')).toHaveLength(1);
    // Eight minutes of talk takes most of the strip, not under 1% of it.
    const width = parseFloat(segment('candidate').getAttribute('width')!);
    expect(width).toBeGreaterThan(70);
    expect(marks().length).toBeLessThanOrEqual(12);
    expect(marks().map((mark) => mark.textContent)).toContain('24:00:00');
  });
});
