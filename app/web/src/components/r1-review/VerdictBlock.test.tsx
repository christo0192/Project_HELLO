/**
 * The AI verdict on an R1 round takes the same colour as the phone Review's: the block, the figure,
 * the circle and the ruler, with the shape, the word and the figures all kept.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { R1Verdict } from '../../lib/r1-review';
import { VerdictBlock } from './VerdictBlock';

const THRESHOLDS = { advance: 65, hold: 45 };
const verdict = (mark: R1Verdict['mark'], overall: number | null, word = 'Word'): R1Verdict => ({ word, mark, overall });
const block = (container: HTMLElement) => container.firstElementChild as HTMLElement;
const zone = (family: string) => document.querySelector<HTMLElement>(`[data-ruler-zone="${family}"]`)!;

describe('VerdictBlock', () => {
  it.each([
    ['full', 'ready'],
    ['half', 'unresolved'],
    ['empty', 'closed'],
  ] as const)('prints a %s verdict in the %s family, keeping its shape', (mark, family) => {
    const { container } = render(<VerdictBlock verdict={verdict(mark, 58)} provisionalNote={null} thresholds={THRESHOLDS} />);
    expect(block(container)).toHaveClass(`bg-${family}-soft`, `border-${family}`, 'border');
    expect(block(container).className).not.toMatch(/border-dashed|border-[lrtbxy]-/);
    expect(container.querySelector('[data-verdict-mark]')).toHaveClass(`text-${family}`);
    expect(container.querySelector('[data-verdict-mark]')).toHaveAttribute('data-verdict-mark', mark);
    expect(screen.getByText('Word')).toHaveClass(`text-${family}-text`);
    expect(screen.getByText('58')).toHaveClass(`text-${family}-text`);
    expect(screen.getByText('/100')).toHaveClass('text-ink-tertiary');
  });

  it('dashes the edge only while provisional, and says so in the unresolved family', () => {
    const { container } = render(
      <VerdictBlock verdict={verdict('full', 70)} provisionalNote="Provisional · 4 of 5 metrics" thresholds={THRESHOLDS} />,
    );
    expect(block(container)).toHaveClass('border-dashed', 'border-ready', 'bg-ready-soft');
    expect(screen.getByText('Provisional · 4 of 5 metrics')).toHaveClass('text-unresolved-text');
  });

  it.each([
    [44, 'empty', 'closed'],
    [45, 'half', 'unresolved'],
    [64, 'half', 'unresolved'],
    [65, 'full', 'ready'],
  ] as const)('at %s, a %s verdict paints the %s zone in its mark and the other two in their light step', (overall, mark, current) => {
    render(<VerdictBlock verdict={verdict(mark, overall)} provisionalNote={null} thresholds={THRESHOLDS} />);
    for (const family of ['closed', 'unresolved', 'ready']) {
      expect(zone(family)).toHaveClass(family === current ? `bg-${family}` : `bg-${family}-light`, 'data-fill');
    }
    expect(document.querySelector('[data-mark]')).toHaveStyle({ left: `${overall}%` });
  });

  it('never says Select beside a Borderline: the integrity floor caps a 72, and the stored verdict decides', () => {
    const { container } = render(<VerdictBlock verdict={verdict('half', 72, 'Borderline')} provisionalNote={null} thresholds={THRESHOLDS} />);
    expect(block(container)).toHaveClass('bg-unresolved-soft', 'border-unresolved');
    expect(zone('unresolved')).toHaveClass('bg-unresolved');
    expect(zone('unresolved')).toHaveAttribute('data-current');
    expect(zone('ready')).toHaveClass('bg-ready-light');
    expect(zone('ready')).not.toHaveAttribute('data-current');
    expect(screen.getByText('Borderline 45')).toHaveClass('font-semibold');
    expect(screen.getByText('Select 65')).not.toHaveClass('font-semibold');
    // The mark still stands at the raw score, in Select's pale zone.
    expect(document.querySelector('[data-mark]')).toHaveStyle({ left: '72%' });
  });

  it('reads the zones and the labels from the round\'s own thresholds', () => {
    render(<VerdictBlock verdict={verdict('half', 58)} provisionalNote={null} thresholds={{ advance: 70, hold: 50 }} />);
    expect([zone('closed'), zone('unresolved'), zone('ready')].map((el) => el.style.width)).toEqual(['50%', '20%', '30%']);
    expect(screen.getByText('Borderline 50')).toHaveClass('text-unresolved-text', 'font-semibold');
    expect(screen.getByText('Select 70')).toHaveClass('text-ready-text');
    expect(screen.getByText('Select 70')).not.toHaveClass('font-semibold');
    expect(screen.getByText('Reject')).toHaveClass('text-closed-text');
  });

  it('keeps the score mark in ink, a data fill so a contrast theme still draws it', () => {
    render(<VerdictBlock verdict={verdict('half', 58)} provisionalNote={null} thresholds={THRESHOLDS} />);
    expect(document.querySelector('[data-mark]')).toHaveClass('bg-ink', 'data-fill');
    expect(document.querySelector('[data-mark]')).toHaveStyle({ left: '58%' });
  });

  it('keeps each cut-off tick a data fill too, or a contrast theme would lose it', () => {
    render(<VerdictBlock verdict={verdict('half', 58)} provisionalNote={null} thresholds={THRESHOLDS} />);
    const ticks = [...document.querySelectorAll<HTMLElement>('[data-cut]')];
    expect(ticks.map((tick) => tick.style.left)).toEqual(['45%', '65%']);
    for (const tick of ticks) expect(tick).toHaveClass('data-fill');
  });

  it('draws no ruler without its thresholds, and still prints the verdict', () => {
    render(<VerdictBlock verdict={verdict('half', 58)} provisionalNote={null} thresholds={null} />);
    expect(document.querySelector('[data-ruler-zone]')).toBeNull();
    expect(screen.getByText('Word')).toBeInTheDocument();
  });
});
