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
