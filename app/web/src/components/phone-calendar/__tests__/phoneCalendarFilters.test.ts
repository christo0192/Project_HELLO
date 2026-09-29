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
  phoneAgentOptions,
  phoneFacets,
  resolvePhoneAgentFilter,
  togglePhoneFacet,
} from '../phoneCalendarFilters';
import {
  PHONE_ROLES,
  ROLE_DATA,
  ROLE_DATA_TWIN,
  ROLE_SALES,
  ROLE_UNKNOWN,
  appointment,
  role,
} from './phoneFixtures';

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
    expect(f.agent).toBeNull();
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

describe('the agent parameter', () => {
  it('reads a role id', () => {
    expect(parse(`agent=${ROLE_SALES}`).agent).toBe(ROLE_SALES);
  });

  it('normalizes case and surrounding space, so one role has one URL', () => {
    expect(parse(`agent=${encodeURIComponent(` ${ROLE_SALES.toUpperCase()} `)}`).agent)
      .toBe(ROLE_SALES);
  });

  it('drops anything that is not the SHAPE of a role id — never echoed as free text', () => {
    // "All agents", not a filter matching nothing: a mistyped link shows the week.
    for (const bad of [
      'nonsense',
      'Sales Advisor',
      '<script>alert(1)</script>',
      `${ROLE_SALES}x`,
      ROLE_SALES.slice(0, -1),
      `${ROLE_SALES},${ROLE_DATA}`,
      '',
    ]) {
      const f = parse(`agent=${encodeURIComponent(bad)}`);
      expect(f.agent, bad).toBeNull();
      expect(buildPhoneCalendarSearch(f).has('agent'), bad).toBe(false);
    }
  });

  it('is written back when set and omitted when it is "All agents"', () => {
    expect(buildPhoneCalendarSearch(parse(`agent=${ROLE_DATA}`)).get('agent')).toBe(ROLE_DATA);
    expect(buildPhoneCalendarSearch(parse('')).has('agent')).toBe(false);
  });
});

describe('building', () => {
  it('round-trips through the URL', () => {
    const f = parse(
      `week=2026-08-24&view=queue&agent=${ROLE_DATA}&status=scheduled,missed&state=eligible`,
    );
    expect(f.agent).toBe(ROLE_DATA);
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

  it('filters on the call s agent (role) pipeline', () => {
    const sales = appointment({ role_id: ROLE_SALES });
    expect(matchesPhoneFilters(sales, parse(`agent=${ROLE_SALES}`))).toBe(true);
    expect(matchesPhoneFilters(sales, parse(`agent=${ROLE_DATA}`))).toBe(false);
    // And it composes with the other dimensions rather than replacing them.
    const missedSales = appointment({ role_id: ROLE_SALES, status: 'missed' });
    expect(matchesPhoneFilters(missedSales, parse(`agent=${ROLE_SALES}&status=missed`))).toBe(true);
    expect(matchesPhoneFilters(missedSales, parse(`agent=${ROLE_SALES}&status=scheduled`)))
      .toBe(false);
  });

  it('never lets a row with no role satisfy an agent filter', () => {
    // A torn read, or an engagement with no role: claiming a match would name
    // a pipeline the API did not report. "All agents" still shows it.
    const roleless = appointment({ role_id: null });
    expect(matchesPhoneFilters(roleless, parse(`agent=${ROLE_SALES}`))).toBe(false);
    expect(matchesPhoneFilters(roleless, parse(''))).toBe(true);
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

  it('counts every facet within the selected agent only', () => {
    // The chips must describe what is on screen: with an agent selected,
    // "Missed 1" means one missed call FOR THAT AGENT, not for the week.
    const mixed = [
      appointment({ id: 's1', role_id: ROLE_SALES, status: 'scheduled', engagement_state: 'scheduled' }),
      appointment({ id: 's2', role_id: ROLE_SALES, status: 'missed', engagement_state: 'failed' }),
      appointment({ id: 'd1', role_id: ROLE_DATA, status: 'missed', engagement_state: 'failed' }),
      appointment({ id: 'd2', role_id: ROLE_DATA, status: 'missed', engagement_state: 'failed' }),
      appointment({ id: 'd3', role_id: ROLE_DATA, status: 'fulfilled', engagement_state: 'completed' }),
    ];
    const all = phoneFacets(mixed, PHONE_STATUS_ORDER, 'status', parse(''));
    expect(all.find((f) => f.value === 'missed')?.count).toBe(3);

    const sales = parse(`agent=${ROLE_SALES}`);
    const statuses = phoneFacets(mixed, PHONE_STATUS_ORDER, 'status', sales);
    expect(statuses.map((f) => [f.value, f.count])).toEqual([['scheduled', 1], ['missed', 1]]);
    const states = phoneFacets(mixed, PHONE_STATE_ORDER, 'state', sales);
    expect(states.map((f) => [f.value, f.count])).toEqual([['scheduled', 1], ['failed', 1]]);

    // A status chip's count still ignores the status selection itself, but
    // never the agent.
    const both = phoneFacets(
      mixed,
      PHONE_STATUS_ORDER,
      'status',
      parse(`agent=${ROLE_DATA}&status=missed`),
    );
    expect(both.map((f) => [f.value, f.count])).toEqual([['fulfilled', 1], ['missed', 2]]);
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
    const base = parse(`week=2026-08-24&view=queue&agent=${ROLE_SALES}&state=eligible`);
    const on = togglePhoneFacet(base, 'status', 'missed');
    expect(on.statuses).toEqual(['missed']);
    expect(on.states).toEqual(['eligible']);
    expect(on.agent).toBe(ROLE_SALES);
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
    expect(hasActivePhoneFilters(parse(`agent=${ROLE_SALES}`))).toBe(true);
  });
});

describe('resolving the agent against the roles the operator can see', () => {
  const KNOWN: ReadonlySet<string> = new Set([ROLE_SALES, ROLE_DATA]);

  it('keeps an agent that names a visible role', () => {
    const f = parse(`agent=${ROLE_SALES}&status=missed`);
    expect(resolvePhoneAgentFilter(f, KNOWN)).toEqual(f);
  });

  it('falls back to "All agents" for a well-formed id that names no visible role', () => {
    // A stale link, or one sent by an admin to an interviewer who does not
    // own that role: the week, not an empty grid with no visible cause.
    const f = parse(`agent=${ROLE_UNKNOWN}&status=missed`);
    const resolved = resolvePhoneAgentFilter(f, KNOWN);
    expect(resolved.agent).toBeNull();
    // Only the agent is dropped.
    expect(resolved.statuses).toEqual(['missed']);
    expect(resolved.weekStart).toBe(MONDAY);
  });

  it('drops the agent when the roles could not be read, because there is no picker', () => {
    const f = parse(`agent=${ROLE_SALES}`);
    expect(resolvePhoneAgentFilter(f, 'unavailable').agent).toBeNull();
  });

  it('keeps the requested agent while the roles are still loading', () => {
    const f = parse(`agent=${ROLE_UNKNOWN}`);
    expect(resolvePhoneAgentFilter(f, 'loading').agent).toBe(ROLE_UNKNOWN);
  });

  it('leaves "All agents" alone whatever the roster says', () => {
    for (const roster of ['loading', 'unavailable', KNOWN] as const) {
      expect(resolvePhoneAgentFilter(parse(''), roster).agent).toBeNull();
    }
  });
});

describe('agent picker options', () => {
  it('labels by agent name, falls back to the title, and tells duplicates apart', () => {
    const options = phoneAgentOptions(PHONE_ROLES);
    expect(options).toEqual([
      { id: ROLE_DATA, label: 'Data Analyst' },
      // Same title, blank agent name: never two identical options.
      { id: ROLE_DATA_TWIN, label: 'Data Analyst (2)' },
      // The agent name wins over the title `Sales Advisor`.
      { id: ROLE_SALES, label: 'Zara' },
    ]);
  });

  it('sorts by the label the operator reads, not by API order', () => {
    const options = phoneAgentOptions([
      role({ id: 'r-3', title: 'zeta role' }),
      role({ id: 'r-1', title: 'Beta role' }),
      role({ id: 'r-2', title: 'alpha role', agent_name: 'Agent 10' }),
      role({ id: 'r-4', title: 'x', agent_name: 'Agent 9' }),
    ]);
    expect(options.map((o) => o.label)).toEqual([
      'Agent 9',
      'Agent 10',
      'Beta role',
      'zeta role',
    ]);
  });

  it('offers nothing for an operator who can see no role', () => {
    expect(phoneAgentOptions([])).toEqual([]);
  });
});
