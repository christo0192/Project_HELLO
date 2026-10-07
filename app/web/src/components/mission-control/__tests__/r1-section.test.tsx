/**
 * R1Section (Mission Control) — usage and allocation tiles.
 *
 * Covers: every tile derived from the two admin reads, the run-state words for
 * each combination of switches, the allowance and lane breakdowns as real
 * tables, a per-source failure shown as a dash (never a zero it did not
 * measure) with retry, the empty month, the link to R1 settings, the
 * dashboard-reading line, dark mode, and axe.
 *
 * Every capacity figure is the API's, read from the 0119 snapshot Send uses:
 * "used", "more sends fit" and "free" come from `committed_minutes` (R1's own
 * minutes against the R1 allocation, the monthly cap) and `sends_left`. The
 * shared pool and its pause line gate sends only on the cloud target (Mode B),
 * where a full pool can leave no sends while R1 itself has used none; on the
 * self-hosted r1 target (Mode A) the pool tile is informational and says so.
 * A dashboard reading from an earlier month is flagged where the guard still
 * counts it (the cloud target).
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
  ledger_since_minutes: 0,
  // The shared Cloud pool: the dashboard reading (1,000) grown by 1.15 x the estimate since.
  guard_minutes: 1150,
  // R1's own: max(110 used, R1 estimate) + 55 held, against the 4,000 allocation.
  committed_minutes: 165,
  // The cloud target: both limits apply, and the pool is the tighter one.
  livekit_target: 'cloud' as const,
  pool_check_applies: true,
  r1_headroom_minutes: 3835,
  pool_committed_minutes: 1269,
  pool_headroom_minutes: 2731,
  // floor(min(3,835, 2,731) / 55).
  sends_left: 49,
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
    // R1's own committed minutes (110 used plus 55 held) against the 4,000 allocation.
    expect(within(allowance).getByText('165')).toBeInTheDocument();
    expect(within(allowance).getByText('/ 4,000 min')).toBeInTheDocument();
    expect(within(allowance).getByText('49 more sends fit · 4% committed')).toBeInTheDocument();

    const started = tile('Interviews started');
    expect(within(started).getByText('2')).toBeInTheDocument();
    expect(within(started).getByText('110 min taken · 55 min held')).toBeInTheDocument();

    const pool = tile('Shared WebRTC pool');
    // The guard (dashboard reading x 1.15, above the pure estimate) over the pause line, which
    // gates sends on the cloud target.
    expect(within(pool).getByText('29%')).toBeInTheDocument();
    expect(within(pool).getByText('1,150 of 4,000 min pause line')).toBeInTheDocument();
  });

  it('on the cloud target a full pool leaves no sends although R1 itself has used none', async () => {
    // 3,450 phone minutes, R1 used and held 0: R1's allocation is untouched (0% committed, all
    // 4,000 free) but the pause line has no room, so the API says no sends fit.
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
      committed_minutes: 0,
      r1_headroom_minutes: 4000,
      pool_committed_minutes: 3967.5,
      pool_headroom_minutes: 32.5,
      sends_left: 0,
    });
    renderSection();
    await waitFor(() => {
      expect(
        within(tile('R1 allowance used')).getByText('0 more sends fit · 0% committed'),
      ).toBeInTheDocument();
    });
    expect(within(tile('Shared WebRTC pool')).getByText('99%').closest('dd')).toHaveClass(
      'text-warning-text',
    );
    const allowance = await screen.findByRole('table', { name: 'R1 allowance data' });
    const free = within(allowance).getByRole('rowheader', { name: 'Free' }).closest('tr')!;
    expect(free).toHaveTextContent('4,000');
  });

  it('on the self-hosted target the pool is information, not a limit (production, Mode A)', async () => {
    // 2026-10-08: the estimate holds 6,396 legacy-browser and 412 phone minutes, far past the pause
    // line, while R1 has used none of its 1,100-minute allocation and holds one link (55).
    apiFns.getR1Usage.mockResolvedValue({
      ...USAGE,
      monthly_cap_minutes: 1100,
      pause_line_minutes: 4000,
      dashboard_minutes: 3900,
      dashboard_read_at: '2026-10-06T10:00:00.000Z',
      minutes_reserved: 55,
      minutes_used: 0,
      starts_admitted: 0,
      r1_minutes: 0,
      phone_minutes: 412,
      legacy_browser_minutes: 6396,
      estimated_minutes: 7829.2,
      guard_minutes: 7829.2,
      committed_minutes: 55,
      livekit_target: 'r1' as const,
      pool_check_applies: false,
      r1_headroom_minutes: 1045,
      pool_committed_minutes: 7884.2,
      pool_headroom_minutes: -3884.2,
      sends_left: 19,
    });
    renderSection();
    await waitFor(() => {
      expect(
        within(tile('R1 allowance used')).getByText('19 more sends fit · 5% committed'),
      ).toBeInTheDocument();
    });
    expect(within(tile('R1 allowance used')).getByText('/ 1,100 min')).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'R1 allowance data' });
    const free = within(table).getByRole('rowheader', { name: 'Free' }).closest('tr')!;
    expect(free).toHaveTextContent('1,045');

    const pool = tile('Shared WebRTC pool');
    expect(within(pool).getByText('196%')).toBeInTheDocument();
    expect(
      within(pool).getByText('7,829 of 4,000 min pause line · informational, R1 is self-hosted'),
    ).toBeInTheDocument();
    // Past the line, but nothing is wrong with R1: no attention colour on the figure.
    expect(within(pool).getByText('196%').closest('dd')).not.toHaveClass('text-warning-text');
    expect(
      screen.getByText(/It sets the shared-pool figure only; it does not limit R1 here/),
    ).toBeInTheDocument();
  });

  it('does not flag a stale dashboard reading on the self-hosted target, where it limits nothing', async () => {
    apiFns.getR1Usage.mockResolvedValue({
      ...USAGE,
      dashboard_minutes: 3900,
      dashboard_read_at: '2026-09-30T20:00:00.000Z',
      livekit_target: 'r1' as const,
      pool_check_applies: false,
    });
    renderSection();
    await screen.findByText(/LiveKit dashboard reading: 3,900 min, read/);
    expect(screen.queryByText(/but the guard still counts it/)).not.toBeInTheDocument();
  });

  it('keeps the cautious reading when an older API does not say which target applies', async () => {
    const older: Record<string, unknown> = { ...USAGE };
    delete older.livekit_target;
    delete older.pool_check_applies;
    apiFns.getR1Usage.mockResolvedValue(older);
    renderSection();
    await waitFor(() => {
      expect(
        within(tile('Shared WebRTC pool')).getByText('1,150 of 4,000 min pause line'),
      ).toBeInTheDocument();
    });
  });

  it('shows the dashboard-reading guard the API computes, over the pause line', async () => {
    // Dashboard 3,600 read today and a smaller pure estimate: the snapshot's pool guard is 4,140.
    apiFns.getR1Usage.mockResolvedValue({
      ...USAGE,
      dashboard_minutes: 3600,
      minutes_reserved: 0,
      minutes_used: 0,
      guard_minutes: 4140,
      committed_minutes: 0,
      pool_committed_minutes: 4140,
      pool_headroom_minutes: -140,
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

  it('uses the monthly cap, the R1 allocation, as the ceiling, not the pause line', async () => {
    apiFns.getR1Usage.mockResolvedValue({ ...USAGE, pause_line_minutes: 1000 });
    renderSection();
    await waitFor(() => {
      expect(within(tile('R1 allowance used')).getByText('/ 4,000 min')).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Against the 4,000-minute R1 allocation \(the monthly cap\)/),
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
      expect(within(tile('R1 allowance used')).getByText('165')).toBeInTheDocument();
    });
    expect(apiFns.getR1Usage).toHaveBeenCalledTimes(2);
  });

  it('shows a dash for the status tile when settings cannot be read', async () => {
    apiFns.getR1Settings.mockRejectedValue(new missionApi.ApiError('nope', 403));
    renderSection();
    await waitFor(() => {
      expect(within(tile('R1 status')).getByText('Not available')).toBeInTheDocument();
    });
    expect(within(tile('R1 allowance used')).getByText('165')).toBeInTheDocument();
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
