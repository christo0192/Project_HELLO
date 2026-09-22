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

import { render, screen, waitFor, within } from '@testing-library/react';
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

describe('RolePipelinePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getScreeningFunnel.mockImplementation(({ role_id }: { role_id: string }) =>
      Promise.resolve({ totals: totalsFor(role_id) }),
    );
  });

  it('asks the funnel for EACH role, once', async () => {
    render(<RolePipelinePanel roles={ROLES} />);
    await screen.findByText('Sales');
    expect(mockApi.getScreeningFunnel).toHaveBeenCalledTimes(2);
    expect(mockApi.getScreeningFunnel).toHaveBeenCalledWith({ role_id: 'r1' });
    expect(mockApi.getScreeningFunnel).toHaveBeenCalledWith({ role_id: 'r2' });
  });

  it('draws one bar per role whose parts sum to that role’s cohort', async () => {
    render(<RolePipelinePanel roles={ROLES} />);
    await screen.findByText('Sales');
    const sales = document.querySelector('[data-role-pipeline="r1"]')!;
    const values = [...sales.querySelectorAll('[data-segment-value]')]
      .filter((el) => !el.getAttribute('data-segment-value')!.startsWith('__'))
      .map((el) => Number(el.textContent));
    expect(values.reduce((a, b) => a + b, 0)).toBe(10);
    // ...and therefore no discrepancy entry is drawn.
    expect(sales.querySelector('[data-segment-value="__remainder"]')).toBeNull();
    expect(sales.querySelector('[data-segment-value="__overflow"]')).toBeNull();
  });

  it('PRINTS THE STAGE TOTALS, so nobody has to add segments up', async () => {
    // The stack shows where people stopped; these are how far they got. Both
    // are needed and only one of them may be stacked.
    render(<RolePipelinePanel roles={ROLES} />);
    await screen.findByText('Sales');
    const sales = document.querySelector('[data-role-pipeline="r1"]')!;
    expect(sales.textContent).toContain('Dialled');
    expect(sales.textContent).toContain('Connected');
    expect(sales.textContent).toContain('Screened');
    // dialled 8 / connected 6 / screened 4 of 10 — the stage figures, not the buckets.
    expect(sales.textContent).toMatch(/Dialled\s*8/);
    expect(sales.textContent).toMatch(/Connected\s*6/);
    expect(sales.textContent).toMatch(/of\s*10/);
  });

  it('NAMES the roles it could not read instead of quietly omitting them', async () => {
    // A chart missing roles reads as "those roles have no pipeline".
    mockApi.getScreeningFunnel.mockImplementation(({ role_id }: { role_id: string }) =>
      role_id === 'r2'
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ totals: totalsFor(role_id) }),
    );
    render(<RolePipelinePanel roles={ROLES} />);
    await screen.findByText('Sales');
    expect(screen.queryByText('Support')).not.toBeInTheDocument();
    const notice = await screen.findByText(/1 role could not be read/);
    expect(notice).toHaveAttribute('data-failed-roles', '1');
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

  it('renders NOTHING when no role has candidates', async () => {
    mockApi.getScreeningFunnel.mockResolvedValue({ totals: funnelTotals() });
    const { container } = render(<RolePipelinePanel roles={ROLES} />);
    await waitFor(() => expect(mockApi.getScreeningFunnel).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('charts ONLY the selected role when the page filter is set', async () => {
    render(<RolePipelinePanel roles={ROLES} roleId="r2" />);
    await screen.findByText('Support');
    expect(screen.queryByText('Sales')).not.toBeInTheDocument();
    expect(mockApi.getScreeningFunnel).toHaveBeenCalledTimes(1);
    expect(mockApi.getScreeningFunnel).toHaveBeenCalledWith({ role_id: 'r2' });
  });

  it('IGNORES A STALE FAN-OUT that lands after the selection changed', async () => {
    // The bug: the empty-selection path returned before bumping the counter,
    // so an in-flight fan-out for the previous selection still passed the
    // staleness check and repainted bars for roles nobody was looking at.
    let releaseSlow: (v: unknown) => void = () => {};
    mockApi.getScreeningFunnel.mockImplementation(({ role_id }: { role_id: string }) =>
      role_id === 'r1'
        ? new Promise((res) => {
            releaseSlow = res;
          })
        : Promise.resolve({ totals: totalsFor(role_id) }),
    );

    const { rerender } = render(<RolePipelinePanel roles={ROLES} roleId="r1" />);
    // Now narrow to a role that is not in the list at all — charts nothing.
    rerender(<RolePipelinePanel roles={ROLES} roleId="gone" />);
    releaseSlow({ totals: totalsFor('r1') });

    await waitFor(() => expect(screen.queryByText('Sales')).not.toBeInTheDocument());
  });

  it('names each bar’s legend after its own role', async () => {
    render(<RolePipelinePanel roles={ROLES} />);
    await screen.findByText('Sales');
    const legend = screen.getByRole('list', { name: 'Pipeline for Sales' });
    // Selected is present but carries the caveat, never a figure.
    expect(within(legend).getByText('Not tracked yet')).toBeInTheDocument();
    expect(legend.querySelector('[data-segment-value="selected"]')).toBeNull();
  });
});
