/**
 * The calendar's filter chips carry the same family swatch as the Candidates chips,
 * so a reader can tell the groups apart in the filter row. jsdom paints nothing, so
 * what is pinned is the fill each swatch asks for and the ring a pressed one keeps.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PhoneFilterBar } from '../PhoneFilterBar';
import type { PhoneFacet } from '../phoneCalendarFilters';
import type { IstDate } from '../../../lib/ist-datetime';

function renderBar(statusFacets: PhoneFacet[], stateFacets: PhoneFacet[] = []) {
  render(
    <PhoneFilterBar
      statusFacets={statusFacets}
      stateFacets={stateFacets}
      filters={{ weekStart: '2026-08-24' as IstDate, view: 'week', agent: null, statuses: [], states: [] }}
      view="week"
      agents={{ status: 'ready', options: [] }}
      onViewChange={vi.fn()}
      onAgentChange={vi.fn()}
      onToggle={vi.fn()}
      onClear={vi.fn()}
    />,
  );
}

const facet = (value: string, active = false): PhoneFacet => ({ value, count: 2, active });

/** The swatch inside the chip with this word. */
function swatch(group: string, word: string): HTMLElement {
  const fieldset = screen.getByRole('group', { name: group });
  const chip = within(fieldset).getByRole('button', { name: new RegExp(`^${word}`) });
  return chip.querySelector<HTMLElement>('[aria-hidden="true"]')!;
}

describe('the phone calendar filter chips', () => {
  it.each([
    ['scheduled', 'Scheduled', 'var(--moving)'],
    // Still to come, as on the badge below it: only Fulfilled is the good result.
    ['confirmed', 'Confirmed', 'var(--moving)'],
    ['fulfilled', 'Fulfilled', 'var(--ready)'],
    ['missed', 'Missed', 'var(--unresolved)'],
    ['cancelled', 'Cancelled', 'var(--closed)'],
    ['superseded', 'Superseded', 'var(--closed)'],
  ])('keys the appointment facet %s (%s) with %s', (value, word, fill) => {
    renderBar([facet(value)]);
    expect(swatch('Appointment', word).style.backgroundColor).toBe(fill);
  });

  it.each([
    ['eligible', 'Eligible', 'var(--moving)'],
    ['completed', 'Completed', 'var(--ready)'],
    ['abandoned_no_answer', 'Abandoned: no answer', 'var(--unresolved)'],
    ['opted_out', 'Opted out', 'var(--closed)'],
    ['failed', 'Failed', 'var(--danger)'],
  ])('keys the engagement facet %s (%s) with %s', (value, word, fill) => {
    renderBar([], [facet(value)]);
    expect(swatch('Engagement', word).style.backgroundColor).toBe(fill);
  });

  it('invents no meaning for a facet the calendar has not been taught', () => {
    renderBar([facet('awaiting_disclosure')]);
    expect(swatch('Appointment', 'awaiting_disclosure').style.backgroundColor).toBe('var(--rule-2)');
  });

  it('keeps the swatch visible on the ink fill of a pressed chip, and only there', () => {
    renderBar([facet('confirmed', true), facet('missed')]);
    expect(swatch('Appointment', 'Confirmed')).toHaveClass('ring-surface');
    expect(swatch('Appointment', 'Missed')).not.toHaveClass('ring-surface');
  });

  it('leaves the word and the count as the signal, and the swatch to forced colours', () => {
    renderBar([facet('confirmed')]);
    const chip = screen.getByRole('button', { name: 'Confirmed 2' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    expect(swatch('Appointment', 'Confirmed')).toHaveClass('data-fill');
  });
});
