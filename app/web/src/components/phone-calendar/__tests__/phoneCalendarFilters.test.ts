/**
 * The deep-link contract and the facet rules.
 *
 * The rule with the most consequence here is the zero-count one: a facet that
 * matches nothing is hidden, EXCEPT when it is the facet currently doing the
 * filtering. Without that exception a deep link such as `?status=missed` into
 * a week with no missed calls would show an empty view and no visible cause.
 */
import { describe, it, expect } from 'vitest';
import {
  PHONE_STATE_ORDER,
  PHONE_STATUS_ORDER,
  buildPhoneCalendarSearch,
  hasActivePhoneFilters,
  matchesPhoneFilters,
  parsePhoneCalendarFilters,
  phoneFacets,
  togglePhoneFacet,
} from '../phoneCalendarFilters';
import { appointment } from './phoneFixtures';

const TODAY = '2026-08-26'; // a Wednesday
const MONDAY = '2026-08-24';

function parse(qs: string) {
  return parsePhoneCalendarFilters(new URLSearchParams(qs), TODAY);
}

describe('parsing', () => {
  it('defaults to the week containing today, in the grid view', () => {
    const f = parse('');
    expect(f.weekStart).toBe(MONDAY);
    expect(f.view).toBe('week');
    expect(f.statuses).toEqual([]);
    expect(f.states).toEqual([]);
  });

  it('normalizes any day of a week to that week s Monday', () => {
    expect(parse('week=2026-08-28').weekStart).toBe(MONDAY);
    expect(parse('week=2026-08-24').weekStart).toBe(MONDAY);
    expect(parse('week=2026-08-30').weekStart).toBe(MONDAY);
  });

  it('falls back to today rather than showing an empty frame for a bad week', () => {
    expect(parse('week=nonsense').weekStart).toBe(MONDAY);
    expect(parse('week=2026-02-30').weekStart).toBe(MONDAY);
  });

  it('drops unknown filter values instead of matching nothing', () => {
    // A mistyped link should show the week, not an empty grid that looks
    // like an outage.
    expect(parse('status=nonsense').statuses).toEqual([]);
    expect(parse('state=nonsense').states).toEqual([]);
    expect(parse('status=missed,nonsense').statuses).toEqual(['missed']);
  });

  it('reads csv values into canonical order regardless of how they were typed', () => {
    expect(parse('status=missed,scheduled').statuses).toEqual(['scheduled', 'missed']);
  });

  it('accepts only the queue view as an override', () => {
    expect(parse('view=queue').view).toBe('queue');
    expect(parse('view=week').view).toBe('week');
    expect(parse('view=galaxy').view).toBe('week');
  });
});

describe('building', () => {
  it('round-trips through the URL', () => {
    const f = parse('week=2026-08-24&view=queue&status=scheduled,missed&state=eligible');
    const qs = buildPhoneCalendarSearch(f).toString();
    expect(parsePhoneCalendarFilters(new URLSearchParams(qs), TODAY)).toEqual(f);
  });

  it('omits the default view rather than restating it', () => {
    const qs = buildPhoneCalendarSearch(parse('')).toString();
    expect(qs).not.toContain('view=');
    expect(qs).toContain('week=2026-08-24');
  });

  it('always carries the week, so a shared link is unambiguous', () => {
    expect(buildPhoneCalendarSearch(parse('')).get('week')).toBe(MONDAY);
  });
});

describe('matching', () => {
  it('passes everything when nothing is selected', () => {
    expect(matchesPhoneFilters(appointment(), parse(''))).toBe(true);
  });

  it('filters on appointment status and engagement state independently', () => {
    const appt = appointment({ status: 'missed', engagement_state: 'failed' });
    expect(matchesPhoneFilters(appt, parse('status=missed'))).toBe(true);
    expect(matchesPhoneFilters(appt, parse('status=scheduled'))).toBe(false);
    expect(matchesPhoneFilters(appt, parse('state=failed'))).toBe(true);
    expect(matchesPhoneFilters(appt, parse('state=eligible'))).toBe(false);
    expect(matchesPhoneFilters(appt, parse('status=missed&state=eligible'))).toBe(false);
  });

  it('never lets a torn read satisfy a state filter', () => {
    // Claiming a match would assert a state the API declined to report.
    const torn = appointment({ engagement_state: null });
    expect(matchesPhoneFilters(torn, parse('state=eligible'))).toBe(false);
    expect(matchesPhoneFilters(torn, parse(''))).toBe(true);
  });
});

describe('facets', () => {
  const rows = [
    appointment({ id: 'a', status: 'scheduled', engagement_state: 'scheduled' }),
    appointment({ id: 'b', status: 'scheduled', engagement_state: 'eligible' }),
    appointment({ id: 'c', status: 'missed', engagement_state: 'failed' }),
  ];

  it('hides facets that would match nothing', () => {
    const facets = phoneFacets(rows, PHONE_STATUS_ORDER, 'status', parse(''));
    expect(facets.map((f) => f.value)).toEqual(['scheduled', 'missed']);
    // `cancelled`, `confirmed`, `fulfilled`, `superseded` all match nothing.
    expect(facets.some((f) => f.count === 0)).toBe(false);
  });

  it('counts truthfully', () => {
    const facets = phoneFacets(rows, PHONE_STATUS_ORDER, 'status', parse(''));
    expect(facets.find((f) => f.value === 'scheduled')?.count).toBe(2);
    expect(facets.find((f) => f.value === 'missed')?.count).toBe(1);
  });

  it('KEEPS a zero-count facet when it is the one deep-linked', () => {
    // The whole point of the exception: `?status=cancelled` on a week with no
    // cancellations must still render the chip that is doing the filtering,
    // or the operator has no visible way to switch it off.
    const filters = parse('status=cancelled');
    const facets = phoneFacets(rows, PHONE_STATUS_ORDER, 'status', filters);
    const cancelled = facets.find((f) => f.value === 'cancelled');
    expect(cancelled).toBeDefined();
    expect(cancelled?.count).toBe(0);
    expect(cancelled?.active).toBe(true);
  });

  it('counts a dimension against the OTHER dimensions, not against itself', () => {
    // With `status=scheduled` selected, the status counts must still show
    // what selecting `missed` would yield — otherwise every unselected chip
    // would read 0 and look dead.
    const facets = phoneFacets(rows, PHONE_STATUS_ORDER, 'status', parse('status=scheduled'));
    expect(facets.find((f) => f.value === 'missed')?.count).toBe(1);

    // But a state filter DOES narrow the status counts.
    const narrowed = phoneFacets(rows, PHONE_STATUS_ORDER, 'status', parse('state=failed'));
    expect(narrowed.find((f) => f.value === 'missed')?.count).toBe(1);
    expect(narrowed.find((f) => f.value === 'scheduled')).toBeUndefined();
  });

  it('excludes torn reads from state counts', () => {
    const withTorn = [...rows, appointment({ id: 'd', engagement_state: null })];
    const facets = phoneFacets(withTorn, PHONE_STATE_ORDER, 'state', parse(''));
    const total = facets.reduce((n, f) => n + f.count, 0);
    expect(total).toBe(3);
  });
});

describe('toggling', () => {
  it('adds and removes a value while preserving every other dimension', () => {
    const base = parse('week=2026-08-24&view=queue&state=eligible');
    const on = togglePhoneFacet(base, 'status', 'missed');
    expect(on.statuses).toEqual(['missed']);
    expect(on.states).toEqual(['eligible']);
    expect(on.view).toBe('queue');
    expect(on.weekStart).toBe(MONDAY);

    const off = togglePhoneFacet(on, 'status', 'missed');
    expect(off.statuses).toEqual([]);
    expect(off.states).toEqual(['eligible']);
  });

  it('keeps canonical order however values are added', () => {
    let f = parse('');
    f = togglePhoneFacet(f, 'status', 'missed');
    f = togglePhoneFacet(f, 'status', 'scheduled');
    expect(f.statuses).toEqual(['scheduled', 'missed']);
  });
});

describe('hasActivePhoneFilters', () => {
  it('ignores the week and the view, which are always set', () => {
    expect(hasActivePhoneFilters(parse('week=2026-08-24&view=queue'))).toBe(false);
    expect(hasActivePhoneFilters(parse('status=missed'))).toBe(true);
    expect(hasActivePhoneFilters(parse('state=eligible'))).toBe(true);
  });
});
