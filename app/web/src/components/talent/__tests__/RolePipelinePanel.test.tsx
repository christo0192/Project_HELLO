/**
 * RolePipelinePanel — the component, not just its arithmetic.
 *
 * This file exists because the component previously had NO coverage at all:
 * every page suite feeds `EMPTY_FUNNEL_TOTALS`, whose zeroed `candidates_total`
 * makes the panel's own "drop roles with no candidates" guard return `null`.
 * The fan-out, the staleness counter, the partial-failure path and the error
 * path were all unreachable by any test, so the one guard keeping the panel
 * out of those suites was the single thing that could never fail one.
 */

import { act, render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockApi = { getScreeningFunnel: vi.fn() };
vi.mock('../../../api', () => ({
  api: { getScreeningFunnel: (...a: unknown[]) => mockApi.getScreeningFunnel(...a) },
  ApiError: class extends Error {},
}));

import { RolePipelinePanel } from '../RolePipelinePanel';
import { funnelTotals } from '../../../test/funnel';

const ROLE = (id: string, title: string) =>
  ({ id, title, jd: '', required_skills: [], screening_template: [] }) as never;

const ROLES = [ROLE('r1', 'Sales'), ROLE('r2', 'Support')];

function totalsFor(role_id: string) {
  return role_id === 'r1'
    ? funnelTotals({ candidates_total: 10, dialed: 8, connected: 6, scored: 4 })
    : funnelTotals({ candidates_total: 4, dialed: 2, connected: 1, scored: 1 });
}

/** Settle the pooled fan-out. A bare `waitFor` on a NEGATIVE assertion is
 *  satisfied by its first synchronous check, before any microtask has run —
 *  which is how the staleness test used to pass with the counter deleted. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** The panel ships collapsed; open it before asserting on any bar. */
async function expand() {
  fireEvent.click(await screen.findByRole('button', { name: /^Show \d+ role/ }));
}

describe('RolePipelinePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getScreeningFunnel.mockImplementation(({ role_id }: { role_id: string }) =>
      Promise.resolve({ totals: totalsFor(role_id) }),
    );
  });

  it('asks the funnel for EACH role, once, and never exceeds the pool', async () => {
    // The old version compared call COUNT only, which an unbounded fan-out
    // satisfies identically. Eight roles against a pool of six is the smallest
    // fixture where the bound is observable.
    const many = Array.from({ length: 8 }, (_, i) => ROLE(`p${i}`, `Role ${i}`));
    let inFlight = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    mockApi.getScreeningFunnel.mockImplementation(() => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise((res) => {
        release.push(() => {
          inFlight -= 1;
          res({ totals: funnelTotals({ candidates_total: 1 }) });
        });
      });
    });

    render(<RolePipelinePanel roles={many} />);
    await waitFor(() => expect(release.length).toBeGreaterThan(0));
    // Exactly six, not seven and not one: an unbounded map would peak at 8,
    // and a pool of 1 would peak at 1.
    expect(peak).toBe(6);
    while (release.length) release.shift()!();
    await settle();
    expect(mockApi.getScreeningFunnel).toHaveBeenCalledTimes(8);
  });

  it('draws ONE BAR PER ROLE, each summing to its own cohort', async () => {
    // `populated.slice(0, 1)` used to pass everything here: no test counted
    // bars, and every other test had at most one populated role.
    render(<RolePipelinePanel roles={ROLES} />);
    await expand();
    expect(document.querySelectorAll('[data-role-pipeline]')).toHaveLength(2);

    for (const [id, cohort] of [
      ['r1', 10],
      ['r2', 4],
    ] as const) {
      const bar = document.querySelector(`[data-role-pipeline="${id}"]`)!;
      const values = [...bar.querySelectorAll('[data-segment-value]')]
        .filter((el) => !el.getAttribute('data-segment-value')!.startsWith('__'))
        .map((el) => Number(el.textContent!.replace(/,/g, '')));
      expect(values.reduce((a, b) => a + b, 0)).toBe(cohort);
      expect(bar.querySelector('[data-segment-value="__remainder"]')).toBeNull();
      expect(bar.querySelector('[data-segment-value="__overflow"]')).toBeNull();
    }
    // ...and in the order the roles were given.
    expect(
      [...document.querySelectorAll('[data-role-pipeline]')].map((el) =>
        el.getAttribute('data-role-pipeline'),
      ),
    ).toEqual(['r1', 'r2']);
  });

  it('PRINTS THE CUMULATIVE STAGE FIGURES under the bar', async () => {
    // Read off the <strong> nodes. `textContent.toContain('Screened')` was
    // satisfied by the LEGEND, so deleting a stage figure passed; and
    // `/of\s*10/` with no right boundary also matched "of 100".
    render(<RolePipelinePanel roles={ROLES} />);
    await expand();
    const sales = document.querySelector('[data-role-pipeline="r1"]')!;
    expect([...sales.querySelectorAll('strong')].map((e) => e.textContent)).toEqual([
      '8',
      '6',
      '4',
    ]);
    expect(sales.textContent).toMatch(/of\s*10\b/);
  });

  it('NAMES the roles it could not read instead of quietly omitting them', async () => {
    // A chart missing roles reads as "those roles have no pipeline".
    mockApi.getScreeningFunnel.mockImplementation(({ role_id }: { role_id: string }) =>
      role_id === 'r2'
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ totals: totalsFor(role_id) }),
    );
    render(<RolePipelinePanel roles={ROLES} />);
    await expand();
    expect(screen.queryByText('Support')).not.toBeInTheDocument();
    const notice = await screen.findByText(/1 role could not be read/);
    expect(notice).toHaveAttribute('data-failed-roles', '1');
    // Visibility is asserted by the sibling test below, which does NOT expand.
    // Asserting it here — after `expand()` — would pass with the notice back
    // inside the collapsed body, which is the defect it is meant to guard.
  });

  it('still reports a failure when every SURVIVING role has no candidates', async () => {
    // The notice sat after `if (populated.length === 0) return null`, so this
    // shape hid the whole panel — silence, which is the one thing the counter
    // exists to prevent.
    mockApi.getScreeningFunnel.mockImplementation(({ role_id }: { role_id: string }) =>
      role_id === 'r2'
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ totals: funnelTotals({ candidates_total: 0 }) }),
    );
    render(<RolePipelinePanel roles={ROLES} />);
    // VISIBLE, not merely present. `findByText` does not filter hidden
    // content, so this passed while the notice sat inside the collapsed body
    // — behind a toggle reading "Show 0 roles", which is the silence the
    // counter exists to break.
    expect(await screen.findByText(/1 role could not be read/)).toBeVisible();
    // ...and no toggle is offered when there is nothing to expand.
    expect(screen.queryByRole('button', { name: /^Show/ })).not.toBeInTheDocument();
  });

  it('SURVIVES a synchronous throw from the client', async () => {
    // `work` absorbs rejections, not sync throws — those escaped the pool,
    // rejected Promise.all, and left the panel blank for ever with an
    // unhandled rejection.
    mockApi.getScreeningFunnel.mockImplementation(() => {
      throw new TypeError('not a function');
    });
    render(<RolePipelinePanel roles={ROLES} />);
    expect(await screen.findByText(/Pipeline figures are unavailable/)).toBeInTheDocument();
  });

  it('reports an outage QUIETLY — status, not an assertive alert', async () => {
    // This panel is supplementary. An alert would interrupt a recruiter before
    // they reach the candidate list, about a chart they did not ask for.
    mockApi.getScreeningFunnel.mockRejectedValue(new Error('down'));
    render(<RolePipelinePanel roles={ROLES} />);
    const notice = await screen.findByText(/Pipeline figures are unavailable/);
    expect(notice.closest('[role="alert"]')).toBeNull();
    expect(notice.closest('[role="status"]')).not.toBeNull();
  });

  it('renders NOTHING once settled with no role having candidates', async () => {
    // Asserted AFTER a real settle. `waitFor` on an empty container is
    // satisfied by its first synchronous check, i.e. by the loading state, so
    // the old version never reached the guard it was named for.
    mockApi.getScreeningFunnel.mockResolvedValue({ totals: funnelTotals() });
    const { container } = render(<RolePipelinePanel roles={ROLES} />);
    await settle();
    expect(mockApi.getScreeningFunnel).toHaveBeenCalledTimes(2);
    expect(container).toBeEmptyDOMElement();
  });

  it('DOES render once settled when a role has candidates (the control)', async () => {
    // Proves the emptiness above is the guard, not just "nothing happened yet".
    const { container } = render(<RolePipelinePanel roles={ROLES} />);
    await settle();
    expect(container).not.toBeEmptyDOMElement();
  });

  it('charts ONLY the selected role when the page filter is set', async () => {
    render(<RolePipelinePanel roles={ROLES} roleId="r2" />);
    await expand();
    expect(screen.getByText('Support')).toBeInTheDocument();
    expect(screen.queryByText('Sales')).not.toBeInTheDocument();
    expect(mockApi.getScreeningFunnel).toHaveBeenCalledTimes(1);
    expect(mockApi.getScreeningFunnel).toHaveBeenCalledWith({ role_id: 'r2' });
  });

  it('IGNORES A STALE FAN-OUT that lands after the selection changed', async () => {
    // Deleting the generation counter used to pass this: the negative
    // assertion was already true when `waitFor` ran its first synchronous
    // check, before the released promise's microtask chain had run at all.
    // The `settle()` is what makes the stale write observable.
    let releaseSlow: (v: unknown) => void = () => {};
    mockApi.getScreeningFunnel.mockImplementation(({ role_id }: { role_id: string }) =>
      role_id === 'r1'
        ? new Promise((res) => {
            releaseSlow = res;
          })
        : Promise.resolve({ totals: totalsFor(role_id) }),
    );

    const { rerender } = render(<RolePipelinePanel roles={ROLES} roleId="r1" />);
    rerender(<RolePipelinePanel roles={ROLES} roleId="gone" />);
    releaseSlow({ totals: totalsFor('r1') });
    await settle();

    expect(screen.queryByText('Sales')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Show \d+ role/ })).not.toBeInTheDocument();
  });

  it('DOES paint when the fan-out is NOT stale (the control)', async () => {
    // Without this, a component that never paints at all would satisfy the
    // staleness test above.
    let release: (v: unknown) => void = () => {};
    mockApi.getScreeningFunnel.mockImplementation(
      () =>
        new Promise((res) => {
          release = res;
        }),
    );
    render(<RolePipelinePanel roles={[ROLES[0]]} roleId="r1" />);
    release({ totals: totalsFor('r1') });
    await settle();
    expect(screen.getByText('Sales')).toBeInTheDocument();
  });

  it('SHIPS COLLAPSED, and says how many roles are behind the toggle', async () => {
    // Expanded this panel is ~290px for one role and 1100px for six, which put
    // the candidate table below the fold.
    render(<RolePipelinePanel roles={ROLES} />);
    const toggle = await screen.findByRole('button', { name: 'Show 2 roles' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // Queried by ROLE, and by visibility. The body stays MOUNTED behind
    // `hidden` so `aria-controls` always resolves (same as the upload panel),
    // and `queryByText` does not filter hidden content — only role queries do.
    expect(screen.queryByRole('heading', { name: 'Sales' })).not.toBeInTheDocument();
    expect(screen.getByText('Sales')).not.toBeVisible();

    fireEvent.click(toggle);
    expect(screen.getByRole('heading', { name: 'Sales' })).toBeVisible();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(toggle);
    expect(screen.queryByRole('heading', { name: 'Sales' })).not.toBeInTheDocument();
  });

  it('names each bar’s legend after its own role', async () => {
    render(<RolePipelinePanel roles={ROLES} />);
    await expand();
    const legend = screen.getByRole('list', { name: 'Pipeline for Sales' });
    // Selected is present but carries the caveat, never a figure.
    expect(within(legend).getByText('Not tracked yet')).toBeInTheDocument();
    expect(legend.querySelector('[data-segment-value="selected"]')).toBeNull();
  });
});
