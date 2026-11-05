/**
 * The week grid's emphasis: the calls that will happen are the boxes on it.
 *
 * A chip sits on paper with no fill of its own, so its edge is what makes it read
 * as a control. The grid once inverted that: withdrawn chips had the edge and the
 * hover, and live ones had neither. jsdom does no painting, so the classes that
 * make the looks different are what is pinned; the look itself is checked on the
 * e2e screenshots.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PhoneAppointmentButton } from '../PhoneAppointmentButton';
import { PhoneWeekTable } from '../PhoneWeekTable';
import type { IstDate } from '../../../lib/ist-datetime';
import { appointment, WINDOW } from './phoneFixtures';

function chipClasses(status: 'scheduled' | 'cancelled' | 'superseded', selected = false): string[] {
  render(
    <PhoneAppointmentButton
      appointment={appointment({ status })}
      selected={selected}
      onSelect={() => {}}
    />,
  );
  return screen.getByRole('button').className.split(/\s+/);
}

describe('appointment chip emphasis', () => {
  it('gives a live chip the control edge and a hover fill', () => {
    const classes = chipClasses('scheduled');
    expect(classes).toEqual(
      expect.arrayContaining(['border', 'border-[var(--control)]', 'bg-surface', 'hover:bg-surface-secondary']),
    );
  });

  it.each(['cancelled', 'superseded'] as const)('leaves a %s chip unboxed at rest', (status) => {
    const classes = chipClasses(status);
    expect(classes).toContain('border-transparent');
    expect(classes).not.toContain('border-[var(--control)]');
    expect(classes).not.toContain('bg-surface');
  });

  it('keeps the same edge width when selected, so the text never moves', () => {
    const classes = chipClasses('scheduled', true);
    expect(classes).toEqual(expect.arrayContaining(['border', 'border-transparent', 'bg-info-soft', 'ring-1']));
  });
});

describe('the Today column', () => {
  it('is a shaded field, since paper on paper marks nothing', () => {
    const today = '2026-08-26' as IstDate;
    render(
      <PhoneWeekTable
        weekDates={['2026-08-25' as IstDate, today]}
        appointments={[]}
        window={WINDOW}
        selectedId={null}
        onSelect={() => {}}
        today={today}
      />,
    );
    const header = screen.getAllByRole('columnheader').at(-1)!;
    expect(header.className).toContain('!bg-surface-secondary');
    const row = screen.getAllByRole('row')[1];
    const cells = row.querySelectorAll('td');
    expect(cells[cells.length - 1].className).toContain('bg-surface-secondary');
    expect(cells[0].className).not.toContain('bg-surface-secondary');
  });
});
