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
  opts: { series?: any[]; refreshedAt?: string | null; meta?: any } = {},
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
    refreshed_at: opts.refreshedAt === undefined ? '2026-09-16T06:00:00Z' : opts.refreshedAt,
    // The panel reads these instead of inferring state from the numbers.
    // Default is a healthy, fully-configured tenant so a test that cares about
    // a degraded state has to say so explicitly.
    meta: {
      hr_tracking_configured: true,
      schema_current: true,
      rollup_refreshed_at: '2026-09-16T06:00:00Z',
      rollup_freshness_known: true,
      refresh_window_days: 30,
      ...(opts.meta ?? {}),
    },
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
    // Distinct values throughout: with `hr_disqualified: 1` next to
    // `scored: 10`, `toContain('1')` matched the 1 in "10", so a card rendering
    // ANY wrong value containing the digit 1 passed.
    getScreeningFunnel.mockResolvedValue(
      funnel({ scored: 26, hr_qualified: 2, hr_disqualified: 4, hr_awaiting: 7 }),
    );
    renderKpis();

    const card = await cardText('Not advanced');
    expect(card).toContain('4');
    expect(card).not.toContain('11');   // 4 + 7, the folded-in version
    expect(
      await screen.findByText(/7 screened candidates are still waiting/i),
    ).toBeInTheDocument();
  });

  it('hides the HR band when Ashby stage tracking is not configured', async () => {
    // THE shape that defeated the previous guard: `reference_check_stage_id`
    // is NULL (how 0090 ships it), so no HR DECISION is reachable — but
    // candidates still sit in the screening stage, so `hr_awaiting > 0`.
    // Inferring "configured" from "some state is non-zero" rendered
    // "Advanced 0 / Not advanced 0" as measured fact. The API now says so.
    getScreeningFunnel.mockResolvedValue(
      funnel(
        { scored: 9, hr_awaiting: 9 },
        { meta: { hr_tracking_configured: false } },
      ),
    );
    renderKpis();

    expect(await screen.findByText(/Not tracked yet/i)).toBeInTheDocument();
    // The cause must be the one an operator can act on — stage data not being
    // kept up to date — not a database or server version.
    expect(screen.queryAllByText(/older database version/i)).toHaveLength(0);
    // The definitions list still documents the card; what must be absent is
    // the CARD itself showing a fabricated 0%.
    const cards = screen.queryAllByText('Advance rate').filter((n) => !n.closest('details'));
    expect(cards).toHaveLength(0);
  });

  it('hides candidate totals and the HR band when the server predates the migration', async () => {
    // The 42703 fallback zero-fills 0098's columns. Rendering those zeros
    // would put "Total candidates 0" beside "Candidates dialled 80" — a funnel
    // narrower at the top than the middle — under a fresh timestamp.
    getScreeningFunnel.mockResolvedValue(
      funnel({ dialed: 80, connected: 20 }, { meta: { schema_current: false } }),
    );
    renderKpis();

    expect(await screen.findByText(/older database version/i)).toBeInTheDocument();
    const totals = screen.queryAllByText('Total candidates').filter((n) => !n.closest('details'));
    expect(totals).toHaveLength(0);
    const rates = screen.queryAllByText('Advance rate').filter((n) => !n.closest('details'));
    expect(rates).toHaveLength(0);
  });

  it('does not call an EMPTY window "never calculated"', async () => {
    // A quiet week returns no rows, so the window has no timestamp — but the
    // roll-up ran an hour ago. Inferring freshness from the returned slice
    // announced that a working system had never computed anything.
    getScreeningFunnel.mockResolvedValue(
      funnel({}, { refreshedAt: null, meta: { rollup_refreshed_at: '2026-09-16T06:00:00Z' } }),
    );
    renderKpis();
    await screen.findAllByText('Total candidates');
    expect(screen.queryAllByText(/have not been calculated yet/i)).toHaveLength(0);
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

  it('says so when the roll-up has genuinely never run', async () => {
    getScreeningFunnel.mockResolvedValue(
      funnel({}, { refreshedAt: null, meta: { rollup_refreshed_at: null } }),
    );
    renderKpis();
    // Stated up top, not only inside the collapsed explanation block — a reader
    // must not have to expand anything to learn the numbers are not real yet.
    const banners = (await screen.findAllByText(/have not been calculated yet/i))
      .filter((n) => !n.closest('details'));
    expect(banners).toHaveLength(1);
  });

  it('shows freshness OUTSIDE the collapsed explanation block', async () => {
    // jsdom renders <details> children regardless of open state, so a bare
    // text query passes even if the line is buried inside it — where a reader
    // would never see it.
    getScreeningFunnel.mockResolvedValue(funnel({ candidates_total: 4 }));
    renderKpis();
    const line = await screen.findByText(/last recalculated/i);
    expect(line.closest('details')).toBeNull();
  });

  it('warns that older days stop being recalculated on a long range', async () => {
    // HR disposition changes weeks after intake, but the roll-up only
    // recomputes a trailing window, so a 90-day view shows frozen HR counts
    // for its older portion.
    getScreeningFunnel.mockResolvedValue(
      funnel({ candidates_total: 4 }, { meta: { refresh_window_days: 30 } }),
    );
    renderKpis();
    await screen.findAllByText('Total candidates');
    fireEvent.click(screen.getByRole('button', { name: '90 days' }));
    expect(await screen.findByText(/no longer recalculated/i)).toBeInTheDocument();
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
    // Web and API deploy independently; an older API omits `meta` and the
    // hr_*/candidates_total totals entirely. Reading `.toLocaleString()` off
    // undefined would throw during render and take the whole dashboard page
    // down with it — and with no `meta` to read, every derived fact has to fall
    // back to "unknown", never to a confident zero.
    const legacy = funnel({ dialed: 5, connected: 3 });
    delete (legacy as Record<string, unknown>).meta;
    delete (legacy.totals as Record<string, unknown>).hr_awaiting;
    delete (legacy.totals as Record<string, unknown>).hr_unknown;
    delete (legacy.totals as Record<string, unknown>).candidates_total;
    getScreeningFunnel.mockResolvedValue(legacy);
    renderKpis();

    expect(await cardText('Candidates dialled')).toContain('5');

    // FAIL CLOSED on every derived fact. `schemaCurrent` used to be
    // `meta?.schema_current !== false`, which reads `undefined` as "the columns
    // are present" — so the single deploy window this flag exists to survive
    // was the one window in which it asserted the opposite, rendering
    // "Total candidates 0" beside "Candidates dialled 5".
    const totals = screen.queryAllByText('Total candidates').filter((n) => !n.closest('details'));
    expect(totals).toHaveLength(0);

    const rates = screen.queryAllByText('Advance rate').filter((n) => !n.closest('details'));
    expect(rates).toHaveLength(0);

    // And it must name the RIGHT cause. Telling the reader to go link a stage
    // in Ashby sends them to fix a correctly-configured job; the actual problem
    // is that the page is ahead of the server.
    // TWO places say it: the panel-level notice explaining the missing totals,
    // and the Team-decision band explaining its own absence. Both are needed —
    // a reader who scrolls to the band should not have to find the banner.
    expect(await screen.findAllByText(/newer than the server/i)).toHaveLength(2);
    // …and not the "go wire up Ashby" message, which would send someone to fix
    // a correctly-configured job. Filtered past the definitions list, which
    // legitimately still documents the card.
    expect(
      screen.queryAllByText(/kept up to date here/i).filter((n) => !n.closest('details')),
    ).toHaveLength(0);

    // …and an absent `meta` is not evidence that nothing was ever computed.
    expect(screen.queryAllByText(/have not been calculated yet/i)).toHaveLength(0);
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

  it('does not let a 403 poison a load that overtakes it', async () => {
    // `forbidden` is deliberately terminal for the mount — the range and role
    // controls are inside the suppressed subtree, so there is nothing to retry
    // with, and a 403 here is a fact about the viewer's role. What must NOT
    // happen is a 403 arriving late and blanking a panel that has already
    // rendered real figures: without `setForbidden(false)` per attempt the flag
    // is sticky, and the reverse order would take a working panel away.
    getScreeningFunnel.mockRejectedValueOnce(new FakeApiError('Insufficient permissions', 403));
    getScreeningFunnel.mockResolvedValue(funnel({ candidates_total: 6 }));

    // Second mount = the state the user lands in after a refresh.
    const first = renderKpis();
    await waitFor(() => expect(first.container.querySelector('section')).toBeNull());
    first.unmount();

    renderKpis();
    expect((await screen.findAllByText('Total candidates')).length).toBeGreaterThan(0);
  });

  it('ignores a slow response that lands after a newer one', async () => {
    // Click 90 days, then 7 before it returns. Without the sequence guard the
    // 90-day payload repaints the panel while the control and the explanation
    // notes both still read "7 days" — 90 days of numbers under a 7-day label,
    // with nothing on screen indicating anything went wrong.
    let releaseSlow: (v: unknown) => void = () => {};
    const slow = new Promise((r) => { releaseSlow = r; });

    getScreeningFunnel.mockReset();
    getScreeningFunnel
      .mockImplementationOnce(() => slow.then(() => funnel({ candidates_total: 900 })))
      .mockResolvedValue(funnel({ candidates_total: 7 }));

    renderKpis();
    await waitFor(() => expect(getScreeningFunnel).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    await waitFor(() => expect(getScreeningFunnel).toHaveBeenCalledTimes(2));
    expect(await cardText('Total candidates')).toContain('7');

    // …now let the stale one land, and give its continuation real ticks to run
    // so "nothing happened" means the guard fired, not that the test finished
    // before the promise chain did.
    releaseSlow(null);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    const card = await cardText('Total candidates');
    expect(card).toContain('7');
    expect(card).not.toContain('900');
  });

  it('requests exactly the number of days the control names', async () => {
    // `dayOffset(rangeDays - 1)` — an off-by-one here silently widens every
    // window by a day and nothing else would notice.
    renderKpis();
    await waitFor(() => expect(getScreeningFunnel).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    await waitFor(() => expect(getScreeningFunnel).toHaveBeenCalledTimes(2));

    const { from, to } = getScreeningFunnel.mock.calls[1][0];
    const days = Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
    ) + 1;
    expect(days).toBe(7);
  });

  it('never prints a negative count when the underlying figures disagree', async () => {
    // `answered_ge1` and `connected` are independent columns; a crashed job can
    // record answers on an attempt whose `answered_at` was never written.
    // `dialed: 11`, not 10: '0' is a substring of '10', so the old fixture let
    // a card rendering `dialed` pass the `toContain('0')` assertion.
    getScreeningFunnel.mockResolvedValue(
      funnel({ dialed: 11, connected: 3, answered_ge1: 5 }),
    );
    renderKpis();
    const card = await cardText('Connected, no answers');
    expect(card).not.toContain('-');
    expect(card).toContain('0');
    expect(card).not.toContain('11');
  });

  it('clamps the OTHER subtraction too', async () => {
    // `neverConnected = dialed - connected` is the same shape as the clamp
    // above and had no fixture at all, so deleting its `Math.max` survived the
    // whole suite. `connected > dialed` happens when a webhook lands for an
    // attempt whose dial row was never written.
    getScreeningFunnel.mockResolvedValue(funnel({ dialed: 3, connected: 8, answered_ge1: 8 }));
    renderKpis();
    const card = await cardText('Never connected');
    expect(card).not.toContain('-');
    expect(card).toContain('0');
  });

  it('says so when the two call counts contradict each other', async () => {
    // Clamping `connectedNoAnswer` to 0 hides the arithmetic but not the
    // contradiction: "Candidates reached 3" still sits above "Answered
    // questions 8". Silence there asks the reader to believe both.
    getScreeningFunnel.mockResolvedValue(funnel({ dialed: 11, connected: 3, answered_ge1: 8 }));
    renderKpis();
    expect(await screen.findByText(/cannot be split cleanly/i)).toBeInTheDocument();
  });

  it('does not cry contradiction on ordinary figures', async () => {
    getScreeningFunnel.mockResolvedValue(funnel({ dialed: 11, connected: 8, answered_ge1: 3 }));
    renderKpis();
    await cardText('Candidates reached');
    expect(screen.queryAllByText(/cannot be split cleanly/i)).toHaveLength(0);
  });

  it('survives a payload whose series is missing entirely', async () => {
    // The `t` memo guards `totals`; nothing guarded `series`. `rows.map` on
    // undefined throws during RENDER, taking the whole DashboardPage down —
    // a worse outcome than the missing-fields case it sits beside.
    const legacy = funnel({ dialed: 5 });
    delete (legacy as Record<string, unknown>).series;
    getScreeningFunnel.mockResolvedValue(legacy);
    renderKpis();
    expect(await cardText('Candidates dialled')).toContain('5');
  });

  it('does not warn about frozen days on a range inside the refresh window', async () => {
    // The threshold was unpinned in the other direction: `>` → `>=` fires the
    // warning on the DEFAULT 30-day view for every user, forever, and the
    // existing test (90 > 30) passes either way.
    getScreeningFunnel.mockResolvedValue(
      funnel({ candidates_total: 4 }, { meta: { refresh_window_days: 90 } }),
    );
    renderKpis();
    await cardText('Total candidates');
    expect(screen.queryAllByText(/no longer recalculated/i)).toHaveLength(0);
  });

  it('warns using the window the SERVER reports, not a hardcoded 30', async () => {
    getScreeningFunnel.mockResolvedValue(
      funnel({ candidates_total: 4 }, { meta: { refresh_window_days: 7 } }),
    );
    renderKpis();
    await cardText('Total candidates');
    expect(await screen.findByText(/Days older than 7 are no longer recalculated/i))
      .toBeInTheDocument();
  });

  it('treats a failed freshness probe as unknown, not as "never calculated"', async () => {
    getScreeningFunnel.mockResolvedValue(
      funnel({ candidates_total: 4, dialed: 3 }, { meta: { rollup_freshness_known: false } }),
    );
    renderKpis();
    await cardText('Total candidates');
    // The banner claims "everything below will read zero" — printed above
    // figures that are plainly not zero.
    expect(screen.queryAllByText(/have not been calculated yet/i)).toHaveLength(0);
    expect(screen.queryAllByText(/last recalculated/i)).toHaveLength(0);
  });

  it('names every band group and resolves each label', async () => {
    // `>= 3` against 5 actual groups let two bands lose their labelling, and
    // an aria-labelledby pointing at a non-existent id passed too.
    const { container } = renderKpis();
    await cardText('Total candidates');
    const groups = Array.from(container.querySelectorAll('[role="group"][aria-labelledby]'));
    expect(groups).toHaveLength(5);
    for (const g of groups) {
      const id = g.getAttribute('aria-labelledby')!;
      expect(document.getElementById(id), `dangling aria-labelledby: ${id}`).not.toBeNull();
    }
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
