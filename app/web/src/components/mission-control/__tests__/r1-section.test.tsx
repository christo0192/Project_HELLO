/**
 * R1Section (Mission Control) — usage and allocation tiles.
 *
 * Covers: every tile derived from the two admin reads, the run-state words for
 * each combination of switches, the allowance and lane breakdowns as real
 * tables, a per-source failure shown as a dash (never a zero it did not
 * measure) with retry, the empty month, the link to R1 settings, the
 * dashboard-reading line, dark mode, and axe.
 *
 * The allowance is the capacity RPCs' own shared-pool test, so "used", "more
 * sends fit" and "free" come from the API's `committed_minutes` and
 * `sends_left`, never from R1's minutes alone (phone minutes can leave no
 * sends while R1 itself has used none). A dashboard reading from an earlier
 * month is flagged, because the guard keeps counting it.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { missionApi, apiFns } from './apiMock';
import { R1Section } from '../R1Section';
import { wrapTheme, chartStubs, forceDarkMode, forceLightMode } from './renderHelpers';

vi.mock('../../../api', () => ({
  api: missionApi.api,
  ApiError: missionApi.ApiError,
}));

const USAGE = {
  month_start: '2026-10-01',
  monthly_cap_minutes: 4000,
  pause_line_minutes: 4000,
  hold_minutes: 55,
  dashboard_minutes: 1000,
  dashboard_read_at: '2026-10-06T10:00:00.000Z',
  minutes_reserved: 55,
  minutes_used: 110,
  starts_admitted: 2,
  r1_minutes: 40,
  phone_minutes: 900,
  legacy_browser_minutes: 10,
  estimated_minutes: 1092.5,
  // max(1,000 dashboard + 0 ledger, 950 pure) x 1.15.
  ledger_since_minutes: 0,
  guard_minutes: 1150,
  // max(110 used, 1,150 guard) + 55 held.
  committed_minutes: 1205,
  // floor((4,000 - 1,205) / 55).
  sends_left: 50,
  runtime: { enabled: true, status: 'enabled' as const },
};

const SETTINGS = {
  enabled: true,
  paused: false,
  auto_status_enabled: false,
  monthly_cap_minutes: 4000,
  pause_line_minutes: 4000,
  advance_threshold: 65,
  hold_threshold: 45,
  livekit_target: 'cloud' as const,
  dashboard_minutes: 1200,
  dashboard_read_at: '2026-10-06T10:00:00.000Z',
  runtime: { enabled: true, status: 'enabled' as const },
};

function renderSection() {
  return render(
    <MemoryRouter>
      {wrapTheme(<R1Section />)}
    </MemoryRouter>,
  );
}

/** The strip cell for this figure: its label, number and context, not its neighbours'. */
function tile(label: string): HTMLElement {
  const term = screen.getAllByText(label).find((el) => el.closest('dl > div'));
  if (!term) throw new Error(`no tile labelled "${label}"`);
  return term.closest('dl > div') as HTMLElement;
}

describe('R1Section (Mission Control)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chartStubs();
    forceLightMode();
    apiFns.getR1Usage.mockResolvedValue(USAGE);
    apiFns.getR1Settings.mockResolvedValue(SETTINGS);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reads the two admin sources exactly once and writes nothing', async () => {
    renderSection();
    await screen.findByText('R1 status');
    await waitFor(() => {
      expect(apiFns.getR1Usage).toHaveBeenCalledTimes(1);
      expect(apiFns.getR1Settings).toHaveBeenCalledTimes(1);
    });
  });

  it('derives every tile from the returned data', async () => {
    renderSection();
    await waitFor(() => {
      expect(within(tile('R1 status')).getByText('On')).toBeInTheDocument();
    });
    expect(
      within(tile('R1 status')).getByText('Automatic status changes are off.'),
    ).toBeInTheDocument();

    const allowance = tile('R1 allowance used');
    // The pool guard (1,150) governs over R1's own 110 used, plus 55 held: 1,205 of 4,000.
    expect(within(allowance).getByText('1,205')).toBeInTheDocument();
    expect(within(allowance).getByText('/ 4,000 min')).toBeInTheDocument();
    expect(within(allowance).getByText('50 more sends fit · 30% committed')).toBeInTheDocument();

    const started = tile('Interviews started');
    expect(within(started).getByText('2')).toBeInTheDocument();
    expect(within(started).getByText('110 min taken · 55 min held')).toBeInTheDocument();

    const pool = tile('Shared WebRTC pool');
    // The guard (dashboard reading x 1.15, above the pure estimate) over the pause line.
    expect(within(pool).getByText('29%')).toBeInTheDocument();
    expect(within(pool).getByText('1,150 of 4,000 min pause line')).toBeInTheDocument();
  });

  it('reports the shared pool, not R1 alone: phone minutes can leave no sends', async () => {
    // The review's figures: 3,450 phone minutes, R1 used and held 0. The R1-only subtraction
    // said "72 more sends fit" and 0% committed while the capacity RPC refused every send.
    apiFns.getR1Usage.mockResolvedValue({
      ...USAGE,
      dashboard_minutes: 0,
      dashboard_read_at: null,
      minutes_reserved: 0,
      minutes_used: 0,
      starts_admitted: 0,
      r1_minutes: 0,
      phone_minutes: 3450,
      legacy_browser_minutes: 0,
      estimated_minutes: 3967.5,
      ledger_since_minutes: 0,
      guard_minutes: 3967.5,
      committed_minutes: 3967.5,
      sends_left: 0,
    });
    renderSection();
    await waitFor(() => {
      expect(
        within(tile('R1 allowance used')).getByText('0 more sends fit · 99% committed'),
      ).toBeInTheDocument();
    });
    expect(within(tile('R1 allowance used')).getByText('3,968').closest('dd')).toHaveClass(
      'text-warning-text',
    );
    const allowance = await screen.findByRole('table', { name: 'R1 allowance data' });
    const free = within(allowance).getByRole('rowheader', { name: 'Free' }).closest('tr')!;
    // 4,000 - 3,967.5: what is genuinely left, not 4,000 - R1's 0.
    expect(free).toHaveTextContent(/32\.5|33/);
    expect(free).not.toHaveTextContent('4,000');
  });

  it('counts the dashboard reading at the same margin the RPC does', async () => {
    // Dashboard 3,600 read today and a smaller pure estimate: the RPC guard is 4,140.
    apiFns.getR1Usage.mockResolvedValue({
      ...USAGE,
      dashboard_minutes: 3600,
      minutes_reserved: 0,
      minutes_used: 0,
      guard_minutes: 4140,
      committed_minutes: 4140,
      sends_left: 0,
    });
    renderSection();
    await waitFor(() => {
      expect(within(tile('Shared WebRTC pool')).getByText('103%')).toBeInTheDocument();
    });
    expect(within(tile('Shared WebRTC pool')).getByText('103%').closest('dd')).toHaveClass(
      'text-warning-text',
    );
    expect(within(tile('R1 allowance used')).getByText(/^0 more sends fit/)).toBeInTheDocument();
  });

  it('uses the lower of the cap and the pause line as the ceiling', async () => {
    apiFns.getR1Usage.mockResolvedValue({ ...USAGE, pause_line_minutes: 1000 });
    renderSection();
    await waitFor(() => {
      expect(within(tile('R1 allowance used')).getByText('/ 1,000 min')).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        /Against the 1,000-minute ceiling \(the lower of the cap and the pause line\)/,
      ),
    ).toBeInTheDocument();
  });

  it('flags a nearly spent allowance and a nearly full pool as needing attention', async () => {
    apiFns.getR1Usage.mockResolvedValue({
      ...USAGE,
      minutes_used: 3800,
      minutes_reserved: 55,
      guard_minutes: 3500,
      committed_minutes: 3855,
      sends_left: 0,
    });
    renderSection();
    await waitFor(() => {
      expect(within(tile('R1 allowance used')).getByText('3,855')).toBeInTheDocument();
    });
    expect(within(tile('R1 allowance used')).getByText('3,855').closest('dd')).toHaveClass(
      'text-warning-text',
    );
    expect(within(tile('Shared WebRTC pool')).getByText('88%').closest('dd')).toHaveClass(
      'text-warning-text',
    );
  });

  it.each([
    ['both switches agree', SETTINGS, USAGE.runtime, 'On'],
    ['switched off in settings', { ...SETTINGS, enabled: false }, USAGE.runtime, 'Off'],
    ['paused', { ...SETTINGS, paused: true }, USAGE.runtime, 'Paused'],
    [
      'off at the API',
      { ...SETTINGS, runtime: { enabled: false, status: 'disabled' as const } },
      { enabled: false, status: 'disabled' as const },
      'Off at the API',
    ],
    [
      'misconfigured',
      { ...SETTINGS, runtime: { enabled: false, status: 'invalid' as const, reason: 'x' } },
      { enabled: false, status: 'invalid' as const, reason: 'x' },
      'Configuration error',
    ],
  ])('says "%s" in words', async (_name, settings, runtime, label) => {
    apiFns.getR1Settings.mockResolvedValue(settings);
    apiFns.getR1Usage.mockResolvedValue({ ...USAGE, runtime });
    renderSection();
    await waitFor(() => {
      expect(within(tile('R1 status')).getByText(label)).toBeInTheDocument();
    });
  });

  it('raises an alert for a configuration error (the red tile the plan promises)', async () => {
    const runtime = { enabled: false, status: 'invalid' as const, reason: 'bad' };
    apiFns.getR1Settings.mockResolvedValue({ ...SETTINGS, runtime });
    renderSection();
    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid R1 setting/);
  });

  it('renders the allowance and the lanes as real tables', async () => {
    renderSection();
    const allowance = await screen.findByRole('table', { name: 'R1 allowance data' });
    expect(within(allowance).getByRole('rowheader', { name: 'Used' })).toBeInTheDocument();
    expect(within(allowance).getByRole('rowheader', { name: 'Held' })).toBeInTheDocument();
    expect(within(allowance).getByRole('rowheader', { name: 'Free' })).toBeInTheDocument();

    const lanes = await screen.findByRole('table', { name: 'WebRTC minutes by lane data' });
    for (const lane of ['R1 interviews', 'Phone', 'Legacy browser']) {
      expect(within(lanes).getByRole('rowheader', { name: lane })).toBeInTheDocument();
    }
  });

  it('shows a dash and a retry, not a zero, when usage cannot be read', async () => {
    apiFns.getR1Usage.mockRejectedValueOnce(new missionApi.ApiError('boom', 503));
    renderSection();
    await waitFor(() => {
      expect(within(tile('R1 allowance used')).getByText('Not available')).toBeInTheDocument();
    });
    expect(within(tile('R1 allowance used')).getByText('Could not load')).toBeInTheDocument();
    // The settings tile still shows what it could read.
    expect(within(tile('R1 status')).getByText('On')).toBeInTheDocument();
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((a) => /R1 allowance: boom/.test(a.textContent ?? ''))).toBe(true);

    fireEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0]!);
    await waitFor(() => {
      expect(within(tile('R1 allowance used')).getByText('1,205')).toBeInTheDocument();
    });
    expect(apiFns.getR1Usage).toHaveBeenCalledTimes(2);
  });

  it('shows a dash for the status tile when settings cannot be read', async () => {
    apiFns.getR1Settings.mockRejectedValue(new missionApi.ApiError('nope', 403));
    renderSection();
    await waitFor(() => {
      expect(within(tile('R1 status')).getByText('Not available')).toBeInTheDocument();
    });
    expect(within(tile('R1 allowance used')).getByText('1,205')).toBeInTheDocument();
  });

  it('says there is nothing to chart for an empty month, without inventing numbers', async () => {
    apiFns.getR1Usage.mockResolvedValue({
      ...USAGE,
      minutes_reserved: 0,
      minutes_used: 0,
      starts_admitted: 0,
      r1_minutes: 0,
      phone_minutes: 0,
      legacy_browser_minutes: 0,
      estimated_minutes: 0,
      ledger_since_minutes: 0,
      guard_minutes: 0,
      committed_minutes: 0,
      sends_left: 72,
      dashboard_minutes: 0,
      dashboard_read_at: null,
    });
    renderSection();
    expect(await screen.findByText('No minutes recorded this month')).toBeInTheDocument();
    expect(within(tile('Interviews started')).getByText('0')).toBeInTheDocument();
    expect(
      within(tile('R1 allowance used')).getByText('72 more sends fit · 0% committed'),
    ).toBeInTheDocument();
  });

  it('links to R1 settings, and refreshes both reads on demand', async () => {
    renderSection();
    const settings = await screen.findByRole('link', { name: 'R1 settings' });
    expect(settings).toHaveAttribute('href', '/admin/r1');
    await waitFor(() => expect(apiFns.getR1Usage).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh R1' }));
    await waitFor(() => {
      expect(apiFns.getR1Usage).toHaveBeenCalledTimes(2);
      expect(apiFns.getR1Settings).toHaveBeenCalledTimes(2);
    });
  });

  it('states the dashboard reading, or says there is none', async () => {
    renderSection();
    expect(
      await screen.findByText(/LiveKit dashboard reading: 1,000 min, read/),
    ).toBeInTheDocument();
    expect(screen.getByText(/The guard never goes below it/)).toBeInTheDocument();
    // Taken this month: nothing to warn about.
    expect(screen.queryByText(/is from .*, but the guard still counts it/)).not.toBeInTheDocument();
  });

  it('flags a dashboard reading from an earlier month, which the guard still counts', async () => {
    apiFns.getR1Usage.mockResolvedValue({
      ...USAGE,
      dashboard_minutes: 3900,
      dashboard_read_at: '2026-09-30T20:00:00.000Z',
    });
    renderSection();
    const notice = await screen.findByText(
      /The last LiveKit dashboard reading is from September 2026, but the guard still counts it/,
    );
    expect(notice).toHaveTextContent('Record this month’s reading in R1 settings.');
    expect(notice.closest('[role="status"]')).not.toBeNull();
  });

  it('judges a reading by the API’s month, not the browser clock', async () => {
    // A reading in the API's own month is current whatever the browser thinks today is.
    apiFns.getR1Usage.mockResolvedValue({
      ...USAGE,
      month_start: '2031-03-01',
      dashboard_read_at: '2031-03-02T10:00:00.000Z',
    });
    renderSection();
    await screen.findByText(/LiveKit dashboard reading: 1,000 min, read/);
    expect(screen.queryByText(/but the guard still counts it/)).not.toBeInTheDocument();
  });

  it('says so when no dashboard reading has ever been recorded', async () => {
    apiFns.getR1Usage.mockResolvedValue({
      ...USAGE,
      dashboard_minutes: 0,
      dashboard_read_at: null,
    });
    renderSection();
    expect(await screen.findByText(/No LiveKit dashboard reading is recorded/)).toBeInTheDocument();
  });

  it('names the month in the header', async () => {
    renderSection();
    expect(await screen.findByText('October 2026')).toBeInTheDocument();
  });

  it('has no axe violations in light mode', async () => {
    const { container } = renderSection();
    await screen.findByRole('table', { name: 'R1 allowance data' });
    await expect(container).toHaveNoViolations();
  });

  it('renders in dark mode with no axe violations', async () => {
    forceDarkMode();
    const { container } = renderSection();
    await screen.findByRole('table', { name: 'R1 allowance data' });
    await expect(container).toHaveNoViolations();
  });

  it('has no axe violations while a source has failed', async () => {
    apiFns.getR1Usage.mockRejectedValue(new missionApi.ApiError('boom', 503));
    const { container } = renderSection();
    await screen.findAllByRole('alert');
    await expect(container).toHaveNoViolations();
  });
});
