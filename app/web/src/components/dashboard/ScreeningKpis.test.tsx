/**
 * ScreeningKpis — the rules that make this block safe in front of an HR head
 * who cannot audit the SQL behind it.
 *
 * These assert on MEANING, not markup. Three independent reviews found that an
 * earlier version of this suite named behaviours it did not pin — the rate
 * arithmetic, the role filter, the charts and the never-computed state were all
 * unasserted, and one fixture collision (`disqualified: 3` next to an expected
 * `'3'`) let a wrong "Needs review" through green. Every fixture below uses
 * DISTINCT values so a card cannot pass by borrowing its neighbour's number.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ThemeProvider } from '../../lib/theme';
import { ScreeningKpis, buildRateSeries } from './ScreeningKpis';
import {
  stubMatchMedia,
  stubResizeObserver,
  stubCanvasContext,
  allowEchartsInitWarnings,
} from '../design/__tests__/helpers';

// The class must be hoisted WITH the spies: `vi.mock` is lifted above every
// top-level declaration, so a plain `class` here is still in its temporal dead
// zone when the factory runs.
const { getScreeningFunnel, listRoles, FakeApiError } = vi.hoisted(() => ({
  getScreeningFunnel: vi.fn(),
  listRoles: vi.fn(),
  FakeApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

vi.mock('../../api', () => ({
  api: {
    getScreeningFunnel: (...args: any[]) => getScreeningFunnel(...args),
    listRoles: (...args: any[]) => listRoles(...args),
  },
  ApiError: FakeApiError,
}));

function totalsOf(overrides: Record<string, number> = {}) {
  return {
    entered_parse: 0, parsed_ok: 0, needs_review: 0, parse_failed: 0,
    dialed: 0, connected: 0, consent_passed: 0, consent_dropped: 0, answered_ge1: 0,
    scored: 0, qualified: 0, on_hold: 0, disqualified: 0, human_review: 0,
    reached_reference_check: 0, attempts_total: 0, connects_total: 0,
    total_call_seconds: 0, hr_qualified: 0, hr_disqualified: 0, hr_awaiting: 0,
    hr_unknown: 0, candidates_total: 0,
    ...overrides,
  };
}

function funnel(
  overrides: Record<string, number> = {},
  opts: { series?: any[]; refreshedAt?: string | null } = {},
) {
  const totals = totalsOf(overrides);
  return {
    range: { from: '2026-08-18', to: '2026-09-16' },
    totals,
    conversions: {
      parse_to_dial: null, dial_to_connect: null, connect_to_consent: null,
      consent_to_answered: null, answered_to_scored: null, scored_to_qualified: null,
      qualified_to_reference_check: null,
      hr_advance_rate:
        totals.hr_qualified + totals.hr_disqualified > 0
          ? totals.hr_qualified / (totals.hr_qualified + totals.hr_disqualified)
          : null,
    },
    series: opts.series ?? [],
    // Default to a REAL timestamp: `null` means "never computed", which is its
    // own state and must not be the silent default every test runs under.
    refreshed_at: opts.refreshedAt === undefined ? '2026-09-16T06:00:00Z' : opts.refreshedAt,
  };
}

/**
 * Text of the KPI CARD with this label. The explanation list reuses the same
 * wording, so a bare text query matches twice.
 */
async function cardText(label: string): Promise<string> {
  await screen.findAllByText(label);
  const node = screen.getAllByText(label).find((n) => !n.closest('details'));
  if (!node) throw new Error(`no KPI card labelled "${label}"`);
  return node.closest('div')?.parentElement?.textContent ?? '';
}

function renderKpis() {
  return render(
    <ThemeProvider>
      <ScreeningKpis />
    </ThemeProvider>,
  );
}

describe('ScreeningKpis', () => {
  beforeEach(() => {
    stubResizeObserver();
    stubCanvasContext();
    stubMatchMedia(true, '(prefers-reduced-motion: reduce)');
    allowEchartsInitWarnings();
    vi.clearAllMocks();
    listRoles.mockResolvedValue([]);
    getScreeningFunnel.mockResolvedValue(funnel());
  });

  // ── The HR band: the numbers most likely to be read as judgement ──────

  it('never counts an untouched candidate as a rejection', async () => {
    // 2 advanced, 1 not advanced, 7 not looked at yet. The 7 must not inflate
    // "Not advanced", or the rejection rate rises when screening speeds UP.
    getScreeningFunnel.mockResolvedValue(
      funnel({ scored: 10, hr_qualified: 2, hr_disqualified: 1, hr_awaiting: 7 }),
    );
    renderKpis();

    const card = await cardText('Not advanced');
    expect(card).toContain('1');
    expect(card).not.toContain('8');
    expect(
      await screen.findByText(/7 screened candidates are still waiting/i),
    ).toBeInTheDocument();
  });

  it('shows the HR band as unconfigured rather than as a wall of zeros', async () => {
    // Nothing observable in Ashby: reference_check_stage_id is unwired. Zeros
    // here would read as "the team rejected everyone and has an empty queue",
    // off a configuration gap.
    getScreeningFunnel.mockResolvedValue(funnel({ scored: 9, hr_unknown: 9 }));
    renderKpis();

    expect(await screen.findByText(/Not tracked yet/i)).toBeInTheDocument();
    // The definitions list still documents the card; what must be absent is
    // the CARD itself, showing a fabricated 0%.
    const cards = screen.queryAllByText('Advance rate').filter((n) => !n.closest('details'));
    expect(cards).toHaveLength(0);
    expect(screen.getByText(/9 screened candidates are waiting on that link/i))
      .toBeInTheDocument();
  });

  it('computes the advance rate over decided candidates only', async () => {
    // 2 advanced, 1 not = 67%. NOT 2/23 — an untouched backlog and untrackable
    // candidates must not drag it down.
    getScreeningFunnel.mockResolvedValue(
      funnel({ hr_qualified: 2, hr_disqualified: 1, hr_awaiting: 20, hr_unknown: 5 }),
    );
    renderKpis();
    expect(await cardText('Advance rate')).toContain('67%');
  });

  it('does not call the advance rate "agreement"', async () => {
    // It never compares the team's decision to the bot's recommendation, so a
    // team that overrode every bot rejection would score 100%.
    getScreeningFunnel.mockResolvedValue(funnel({ hr_qualified: 1, hr_disqualified: 1 }));
    renderKpis();
    await screen.findAllByText('Advance rate');
    expect(screen.queryByText(/Team agreement/i)).toBeNull();
  });

  // ── Rates ─────────────────────────────────────────────────────────────

  it('shows a rate with no denominator as unknown, not as zero', async () => {
    getScreeningFunnel.mockResolvedValue(funnel({ candidates_total: 5, dialed: 0, connected: 0 }));
    renderKpis();
    const card = await cardText('Connect rate');
    expect(card).toContain('—');
    expect(card).not.toContain('0%');
  });

  it('computes the connect rate the right way up', async () => {
    // Pins the ARITHMETIC, not just the zero-denominator branch: inverting the
    // ratio would give 400%, dropping the ×100 would give 0%.
    getScreeningFunnel.mockResolvedValue(funnel({ dialed: 80, connected: 20 }));
    renderKpis();
    expect(await cardText('Connect rate')).toContain('25%');
  });

  it('puts the rate next to its own numerator and denominator', async () => {
    // A reader must be able to reproduce the percentage from adjacent cards.
    // Attempt-level counts live in their own band for exactly this reason.
    getScreeningFunnel.mockResolvedValue(
      funnel({ dialed: 80, connected: 20, attempts_total: 250, connects_total: 60 }),
    );
    renderKpis();
    expect(await cardText('Candidates dialled')).toContain('80');
    expect(await cardText('Candidates reached')).toContain('20');
    expect(await cardText('Total call attempts')).toContain('250');
  });

  // ── Derived counts ────────────────────────────────────────────────────

  it('separates connected-but-silent from never-connected', async () => {
    getScreeningFunnel.mockResolvedValue(
      funnel({ dialed: 31, connected: 17, answered_ge1: 12 }),
    );
    renderKpis();
    expect(await cardText('Connected, no answers')).toContain('5');  // 17 − 12
    expect(await cardText('Never connected')).toContain('14');       // 31 − 17
  });

  it('surfaces hold and no-recommendation as one reviewable bucket', async () => {
    // Distinct values throughout so this cannot pass by matching a neighbour.
    getScreeningFunnel.mockResolvedValue(
      funnel({ scored: 30, qualified: 11, disqualified: 12, on_hold: 4, human_review: 3 }),
    );
    renderKpis();
    expect(await cardText('Needs review')).toContain('7'); // 4 + 3
  });

  // ── States that must not look like data ───────────────────────────────

  it('says so when the figures have never been calculated', async () => {
    // All-zero with refreshed_at null is "not computed", not "nothing
    // happened" — and those must not look identical.
    getScreeningFunnel.mockResolvedValue(funnel({}, { refreshedAt: null }));
    renderKpis();
    expect(await screen.findByText(/have not been calculated yet/i)).toBeInTheDocument();
  });

  it('shows when the figures were last calculated, without expanding anything', async () => {
    getScreeningFunnel.mockResolvedValue(funnel({ candidates_total: 4 }));
    renderKpis();
    expect(await screen.findByText(/last recalculated/i)).toBeInTheDocument();
  });

  it('renders nothing at all for a role that cannot read screening metrics', async () => {
    // A viewer gets 403. A red panel with an unusable "Try again" would make
    // the whole dashboard look broken.
    getScreeningFunnel.mockRejectedValue(new FakeApiError('Insufficient permissions', 403));
    const { container } = renderKpis();
    await waitFor(() => expect(container.querySelector('section')).toBeNull());
    expect(screen.queryByText(/unavailable/i)).toBeNull();
  });

  it('survives a payload that predates the new fields', async () => {
    // Web and API deploy independently; an older API omits hr_*/candidates_total
    // entirely. Reading .toLocaleString() off undefined would throw during
    // render and take the whole dashboard page down with it.
    const legacy = funnel({ dialed: 5, connected: 3 });
    delete (legacy.totals as Record<string, unknown>).hr_awaiting;
    delete (legacy.totals as Record<string, unknown>).hr_unknown;
    delete (legacy.totals as Record<string, unknown>).candidates_total;
    getScreeningFunnel.mockResolvedValue(legacy);
    renderKpis();
    expect(await cardText('Candidates dialled')).toContain('5');
  });

  // ── Charts ────────────────────────────────────────────────────────────

  it('leaves a gap for a day with no denominator instead of plotting 0%', () => {
    // Asserted on the pure builder, NOT through a rendered chart: the chart's
    // sr-only data table may not exist under jsdom, which would silently turn
    // this into a no-op — the exact vacuity that let an earlier `?? 0` survive.
    const rows = [
      { cohort_day: '2026-09-14', dialed: 10, connected: 5 },
      { cohort_day: '2026-09-15', dialed: 0, connected: 0 },   // nobody dialled
      { cohort_day: '2026-09-16', dialed: 8, connected: 6 },
    ] as any[];

    const series = buildRateSeries(rows, (r) => r.connected, (r) => r.dialed);

    // The empty day is ABSENT, not present as 0.
    expect(series).toHaveLength(2);
    expect(series.map((p) => p.value)).toEqual([50, 75]);
    expect(series.some((p) => p.value === 0)).toBe(false);
  });

  it('keeps a genuine 0% — a real zero is not the same as an unknown', () => {
    // 10 dialled, nobody reached: that IS 0% and must be plotted.
    const rows = [{ cohort_day: '2026-09-14', dialed: 10, connected: 0 }] as any[];
    const series = buildRateSeries(rows, (r) => r.connected, (r) => r.dialed);
    expect(series).toEqual([{ label: expect.any(String), value: 0 }]);
  });

  // ── Controls ──────────────────────────────────────────────────────────

  it('requests a different window when the range changes', async () => {
    renderKpis();
    await waitFor(() => expect(getScreeningFunnel).toHaveBeenCalled());
    const first = getScreeningFunnel.mock.calls[0][0];
    expect(first.to).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    await waitFor(() => expect(getScreeningFunnel).toHaveBeenCalledTimes(2));
    const second = getScreeningFunnel.mock.calls[1][0];

    expect(second.from > first.from).toBe(true);
    expect(second.to).toBe(first.to);   // the window shortens from the start
  });

  it('passes the selected role through to the request', async () => {
    listRoles.mockResolvedValue([{ id: 'role-1', title: 'Sales Program Advisor' }]);
    renderKpis();
    await waitFor(() => expect(getScreeningFunnel).toHaveBeenCalled());

    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'role-1' } });
    await waitFor(() => expect(getScreeningFunnel).toHaveBeenCalledTimes(2));
    expect(getScreeningFunnel.mock.calls[1][0].role_id).toBe('role-1');
  });

  it('groups each band for assistive tech, not just visually', async () => {
    renderKpis();
    const groups = await screen.findAllByRole('group');
    const named = groups.map((g) => g.getAttribute('aria-labelledby')).filter(Boolean);
    expect(named.length).toBeGreaterThanOrEqual(3);
  });

  it('explains the metrics on the page, not in a wiki', async () => {
    renderKpis();
    expect(await screen.findByText(/How these numbers are calculated/i)).toBeInTheDocument();
    expect(
      screen.getByText(/rejection rate would climb every time screening got faster/i),
    ).toBeInTheDocument();
    // The two definitions most likely to be misread.
    expect(screen.getByText(/counts DIALS, not people/i)).toBeInTheDocument();
    expect(screen.getByText(/NOT a measure of agreement/i)).toBeInTheDocument();
  });

  it('degrades to a retryable error instead of a blank panel', async () => {
    getScreeningFunnel.mockRejectedValue(new FakeApiError('boom', 500));
    renderKpis();
    expect(await screen.findByText(/Screening metrics unavailable/i)).toBeInTheDocument();

    getScreeningFunnel.mockResolvedValue(funnel({ candidates_total: 3 }));
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect((await screen.findAllByText('Total candidates')).length).toBeGreaterThan(0);
  });
});
