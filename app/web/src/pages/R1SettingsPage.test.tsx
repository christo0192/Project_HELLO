/**
 * R1SettingsPage — the admin page for the R1 sales role-play.
 *
 * Covers: loading, load failure and the non-admin gate; the form showing what
 * the server said; client validation that blocks a request and focuses the
 * field; a patch of ONLY what changed; the confirmation for the settings that
 * change behaviour (including resuming from a pause); server refusals; the
 * separate dashboard-reading form, which must not undo another admin's change
 * to the saved row (the draft is rebased) and flags a reading from an earlier
 * month; and labels, focus, keyboard and axe.
 *
 * Reading timestamps that must NOT be stale are built from the clock, so the
 * suite does not age into failure when the calendar month turns.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { R1SettingsPage } from './R1SettingsPage';

const api = vi.hoisted(() => ({
  getR1Settings: vi.fn(),
  updateR1Settings: vi.fn(),
}));

vi.mock('../api', () => ({
  api,
  ApiError: class extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

const SAVED = {
  enabled: false,
  paused: false,
  auto_status_enabled: false,
  monthly_cap_minutes: 4000,
  pause_line_minutes: 4000,
  admission_hold_minutes: 55,
  advance_threshold: 65,
  hold_threshold: 45,
  livekit_target: 'cloud' as const,
  dashboard_minutes: 0,
  dashboard_read_at: null,
  updated_at: '2026-10-06T10:00:00.000Z',
  runtime: { enabled: true, status: 'enabled' as const },
};

function renderPage() {
  return render(
    <MemoryRouter>
      <R1SettingsPage />
    </MemoryRouter>,
  );
}

async function loaded() {
  return screen.findByRole('heading', { level: 1, name: 'R1 settings' });
}

const field = (name: RegExp | string) => screen.getByRole('textbox', { name });
const toggle = (name: string) => screen.getByRole('switch', { name });
const save = () => screen.getByRole('button', { name: 'Save changes' });

beforeEach(() => {
  vi.clearAllMocks();
  api.getR1Settings.mockResolvedValue(SAVED);
  api.updateR1Settings.mockImplementation(async (patch: Record<string, unknown>) => ({
    ...SAVED,
    ...patch,
    updated_at: '2026-10-06T11:00:00.000Z',
  }));
});

describe('loading and access', () => {
  it('shows a loading state, then the page', async () => {
    api.getR1Settings.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByText('Loading R1 settings…')).toBeInTheDocument();
  });

  it('shows a retryable error when the settings cannot be read', async () => {
    api.getR1Settings.mockRejectedValueOnce(new ApiError('service_unavailable', 503));
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('service_unavailable');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await loaded();
  });

  it('tells a non-admin plainly, without a form', async () => {
    api.getR1Settings.mockRejectedValue(new ApiError('Insufficient permissions', 403));
    renderPage();
    expect(await screen.findByText(/Admin access required/)).toBeInTheDocument();
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });
});

describe('what the form shows', () => {
  it('fills every control from the saved settings, with labelled fields', async () => {
    renderPage();
    await loaded();
    expect(toggle('R1 enabled')).toHaveAttribute('aria-checked', 'false');
    expect(toggle('Paused')).toHaveAttribute('aria-checked', 'false');
    expect(toggle('Automatic status changes')).toHaveAttribute('aria-checked', 'false');
    expect(field('Monthly cap (minutes)')).toHaveValue('4000');
    expect(field('Pause line (minutes)')).toHaveValue('4000');
    expect(field('Advance threshold')).toHaveValue('65');
    expect(field('Hold threshold')).toHaveValue('45');
    expect(screen.getByText(/Last saved/)).toBeInTheDocument();
  });

  describe('the monthly cap is R1’s allocation (0119), not a combined ceiling (P2)', () => {
    it.each(['cloud', 'r1'] as const)(
      'summarises the cap alone, whatever the pause line, on the %s target',
      async (target) => {
        api.getR1Settings.mockResolvedValue({
          ...SAVED,
          livekit_target: target,
          monthly_cap_minutes: 5000,
          pause_line_minutes: 550,
        });
        renderPage();
        await loaded();
        // The old summary showed min(cap, pause line) = 550, "shared with phone".
        expect(screen.getByText('5,000 min R1 allocation')).toBeInTheDocument();
        expect(screen.queryByText(/min ceiling/)).not.toBeInTheDocument();
        expect(screen.queryByText(/lower of the two limits/)).not.toBeInTheDocument();
      },
    );

    it('describes the cap as R1’s own allocation that phone use does not count against', async () => {
      renderPage();
      await loaded();
      expect(screen.queryByText(/sends a month/)).not.toBeInTheDocument();
      expect(
        screen.getByText(/R1’s own allocation for the month \(sessions × 55 minutes\)/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Phone and legacy browser use do not count against it/),
      ).toBeInTheDocument();
      // The old hint said the opposite.
      expect(screen.queryByText(/Phone use counts against it/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Ceiling on the month/)).not.toBeInTheDocument();
    });

    it('uses the hold the API reports in the cap hint and the section description', async () => {
      api.getR1Settings.mockResolvedValue({ ...SAVED, admission_hold_minutes: 60 });
      renderPage();
      await loaded();
      expect(screen.getByText(/\(sessions × 60 minutes\)/)).toBeInTheDocument();
      expect(
        screen.getByText(/Each send reserves 60 minutes of R1’s allocation/),
      ).toBeInTheDocument();
    });

    it('tracks the cap being typed, and drops the summary when it is not a number', async () => {
      const user = userEvent.setup();
      renderPage();
      await loaded();
      expect(screen.getByText('4,000 min R1 allocation')).toBeInTheDocument();
      await user.clear(field('Monthly cap (minutes)'));
      await user.type(field('Monthly cap (minutes)'), '1100');
      expect(screen.getByText('1,100 min R1 allocation')).toBeInTheDocument();
      await user.clear(field('Monthly cap (minutes)'));
      expect(screen.queryByText(/min R1 allocation/)).not.toBeInTheDocument();
    });

    it('says on LiveKit Cloud that BOTH the allocation and the pause line must have room', async () => {
      renderPage(); // SAVED is on the cloud target
      await loaded();
      expect(
        screen.getByText(
          /Both limits must have room: R1’s allocation and the Cloud pool’s pause line\./,
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/The Cloud pool’s line: R1, phone and legacy browser together/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/R1 stops taking sends when the month’s pool use reaches it/),
      ).toBeInTheDocument();
    });

    it('says on the dedicated R1 server that only the allocation applies', async () => {
      api.getR1Settings.mockResolvedValue({ ...SAVED, livekit_target: 'r1' });
      renderPage();
      await loaded();
      expect(
        screen.getByText(
          /Only R1’s allocation applies; the Cloud pool’s pause line gates nothing here\./,
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/gates nothing now; it applies again only if R1 moves back to LiveKit Cloud/),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Both limits must have room/)).not.toBeInTheDocument();
      expect(
        screen.queryByText(/R1 stops taking sends when the month’s pool use reaches it/),
      ).not.toBeInTheDocument();
    });

    it('still lets the pause line be edited on the r1 target, for if R1 moves back', async () => {
      api.getR1Settings.mockResolvedValue({ ...SAVED, livekit_target: 'r1' });
      const user = userEvent.setup();
      renderPage();
      await loaded();
      await user.clear(field('Pause line (minutes)'));
      await user.type(field('Pause line (minutes)'), '3500');
      await user.click(save());
      expect(api.updateR1Settings).toHaveBeenCalledWith({ pause_line_minutes: 3500 });
    });

    it('reads an unknown target as gating, the cautious reading', async () => {
      api.getR1Settings.mockResolvedValue({ ...SAVED, livekit_target: 'elsewhere' });
      renderPage();
      await loaded();
      expect(screen.getByText(/Both limits must have room/)).toBeInTheDocument();
    });
  });

  it('says R1 is off, and why the switch alone is not enough when the API disagrees', async () => {
    api.getR1Settings.mockResolvedValue({
      ...SAVED,
      enabled: true,
      runtime: { enabled: false, status: 'disabled' },
    });
    renderPage();
    await loaded();
    expect(screen.getByText('R1: Off at the API.')).toBeInTheDocument();
    expect(screen.getByText(/R1_ENABLED is not "true" on the API/)).toBeInTheDocument();
  });

  it('raises an alert for a configuration error', async () => {
    api.getR1Settings.mockResolvedValue({
      ...SAVED,
      runtime: { enabled: false, status: 'invalid', reason: 'bad value' },
    });
    renderPage();
    await loaded();
    expect(screen.getByText('R1: Configuration error.').closest('[role="alert"]')).not.toBeNull();
  });

  it('shows the media server as information, not as a control', async () => {
    renderPage();
    await loaded();
    expect(screen.getByText(/Media server: LiveKit Cloud, shared with phone/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('links back to Mission Control', async () => {
    renderPage();
    await loaded();
    expect(screen.getByRole('link', { name: 'Back to Mission Control' })).toHaveAttribute(
      'href',
      '/mission-control#r1',
    );
  });
});

describe('editing', () => {
  it('keeps Save and Discard disabled until something changes, and Discard restores', async () => {
    const user = userEvent.setup();
    renderPage();
    await loaded();
    expect(save()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Discard changes' })).toBeDisabled();

    await user.clear(field('Monthly cap (minutes)'));
    await user.type(field('Monthly cap (minutes)'), '3000');
    expect(save()).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(field('Monthly cap (minutes)')).toHaveValue('4000');
    expect(save()).toBeDisabled();
  });

  it('sends only the fields that changed, as numbers, and shows the server’s answer', async () => {
    const user = userEvent.setup();
    renderPage();
    await loaded();
    await user.clear(field('Monthly cap (minutes)'));
    await user.type(field('Monthly cap (minutes)'), '3000');
    await user.clear(field('Advance threshold'));
    await user.type(field('Advance threshold'), '70.5');
    await user.click(toggle('Paused'));
    await user.click(save());

    expect(api.updateR1Settings).toHaveBeenCalledTimes(1);
    expect(api.updateR1Settings).toHaveBeenCalledWith({
      paused: true,
      monthly_cap_minutes: 3000,
      advance_threshold: 70.5,
    });
    expect(await screen.findByText('Settings saved.')).toBeInTheDocument();
    expect(toggle('Paused')).toHaveAttribute('aria-checked', 'true');
    expect(field('Monthly cap (minutes)')).toHaveValue('3000');
    expect(save()).toBeDisabled();
    // The PUT answer carries no runtime status; the last known one is kept.
    expect(
      screen.getByText(/Switched off in R1 settings|New sends are blocked/),
    ).toBeInTheDocument();
  });

  it('submits from the keyboard with Enter in a field', async () => {
    const user = userEvent.setup();
    renderPage();
    await loaded();
    await user.clear(field('Hold threshold'));
    await user.type(field('Hold threshold'), '40{Enter}');
    await waitFor(() => expect(api.updateR1Settings).toHaveBeenCalledWith({ hold_threshold: 40 }));
  });

  it('reaches every control in page order, skipping the buttons that cannot act yet', async () => {
    const user = userEvent.setup();
    renderPage();
    await loaded();
    const nameOf = (el: HTMLElement): string => {
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) return document.getElementById(labelledBy)?.textContent ?? '';
      if (el instanceof HTMLInputElement) return el.labels?.[0]?.textContent ?? '';
      return el.textContent?.trim() ?? '';
    };
    const order: string[] = [];
    for (let i = 0; i < 9; i += 1) {
      await user.tab();
      order.push(nameOf(document.activeElement as HTMLElement));
    }
    // Save and Discard are disabled until something changes, so Tab skips them.
    expect(order).toEqual([
      'Back to Mission Control',
      'R1 enabled',
      'Paused',
      'Monthly cap (minutes)',
      'Pause line (minutes)',
      'Advance threshold',
      'Hold threshold',
      'Automatic status changes',
      'New reading (minutes)',
    ]);
  });
});

describe('validation', () => {
  it('blocks the request, explains the field, and focuses it', async () => {
    const user = userEvent.setup();
    renderPage();
    await loaded();
    await user.clear(field('Monthly cap (minutes)'));
    await user.type(field('Monthly cap (minutes)'), 'abc');
    await user.click(save());

    expect(api.updateR1Settings).not.toHaveBeenCalled();
    expect(field('Monthly cap (minutes)')).toHaveFocus();
    expect(field('Monthly cap (minutes)')).toHaveAttribute('aria-invalid', 'true');
    const message = screen.getByText('Enter a whole number of minutes, 1 or more.');
    expect(message).toHaveAttribute('role', 'alert');
    expect(field('Monthly cap (minutes)')).toHaveAccessibleDescription(
      'Enter a whole number of minutes, 1 or more.',
    );
  });

  it('focuses the FIRST invalid field in page order', async () => {
    const user = userEvent.setup();
    renderPage();
    await loaded();
    await user.clear(field('Hold threshold'));
    await user.type(field('Hold threshold'), '999');
    await user.clear(field('Pause line (minutes)'));
    await user.click(save());
    expect(field('Pause line (minutes)')).toHaveFocus();
    expect(screen.getAllByRole('alert')).toHaveLength(2);
  });

  it('refuses a hold threshold above the advance threshold, naming the hold field', async () => {
    const user = userEvent.setup();
    renderPage();
    await loaded();
    await user.clear(field('Advance threshold'));
    await user.type(field('Advance threshold'), '40');
    await user.click(save());
    expect(api.updateR1Settings).not.toHaveBeenCalled();
    expect(field('Hold threshold')).toHaveFocus();
    expect(
      screen.getByText('The hold threshold cannot be above the advance threshold.'),
    ).toBeInTheDocument();
  });

  it('clears a field’s error as soon as it is edited', async () => {
    const user = userEvent.setup();
    renderPage();
    await loaded();
    await user.clear(field('Monthly cap (minutes)'));
    await user.click(save());
    expect(screen.getByText('Enter a whole number of minutes, 1 or more.')).toBeInTheDocument();
    await user.type(field('Monthly cap (minutes)'), '1');
    expect(
      screen.queryByText('Enter a whole number of minutes, 1 or more.'),
    ).not.toBeInTheDocument();
  });
});

describe('the confirmation', () => {
  it('asks before switching R1 on, saying what happens, and sends nothing yet', async () => {
    const user = userEvent.setup();
    renderPage();
    await loaded();
    await user.click(toggle('R1 enabled'));
    await user.click(save());

    const group = await screen.findByRole('group', { name: 'Confirm these changes' });
    expect(group).toHaveFocus();
    expect(group).toHaveTextContent('Saving will switch R1 on, so HR can send candidate links.');
    expect(api.updateR1Settings).not.toHaveBeenCalled();

    await user.click(within(group).getByRole('button', { name: 'Confirm and save' }));
    expect(api.updateR1Settings).toHaveBeenCalledWith({ enabled: true });
    expect(await screen.findByText('Settings saved.')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Confirm these changes' })).not.toBeInTheDocument();
  });

  it('spells out what automatic status changes do, with both reasons when two apply', async () => {
    const user = userEvent.setup();
    renderPage();
    await loaded();
    await user.click(toggle('R1 enabled'));
    await user.click(toggle('Automatic status changes'));
    await user.click(save());
    const group = await screen.findByRole('group', { name: 'Confirm these changes' });
    expect(group).toHaveTextContent(/switch R1 on/);
    expect(group).toHaveTextContent(/advance now, reject after 24 hours/);
  });

  it('asks before switching R1 off or stopping automatic status changes', async () => {
    api.getR1Settings.mockResolvedValue({ ...SAVED, enabled: true, auto_status_enabled: true });
    const user = userEvent.setup();
    renderPage();
    await loaded();
    await user.click(toggle('Automatic status changes'));
    await user.click(save());
    expect(await screen.findByRole('group', { name: 'Confirm these changes' })).toHaveTextContent(
      /stop R1 changing candidate status/,
    );
  });

  it('asks before RESUMING R1 from a pause, saying what that allows', async () => {
    api.getR1Settings.mockResolvedValue({ ...SAVED, enabled: true, paused: true });
    const user = userEvent.setup();
    renderPage();
    await loaded();
    await user.click(toggle('Paused'));
    await user.click(save());
    const group = await screen.findByRole('group', { name: 'Confirm these changes' });
    expect(group).toHaveTextContent(/resume R1, so new sends and interview starts are allowed/);
    expect(api.updateR1Settings).not.toHaveBeenCalled();
    await user.click(within(group).getByRole('button', { name: 'Confirm and save' }));
    expect(api.updateR1Settings).toHaveBeenCalledWith({ paused: false });
  });

  it('does not ask for a change that is only a limit or a pause', async () => {
    const user = userEvent.setup();
    renderPage();
    await loaded();
    await user.click(toggle('Paused'));
    await user.click(save());
    expect(screen.queryByRole('group', { name: 'Confirm these changes' })).not.toBeInTheDocument();
    expect(api.updateR1Settings).toHaveBeenCalledWith({ paused: true });
  });

  it('lets the person keep editing, and closes if they edit anything meanwhile', async () => {
    const user = userEvent.setup();
    renderPage();
    await loaded();
    await user.click(toggle('R1 enabled'));
    await user.click(save());
    await user.click(await screen.findByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('group', { name: 'Confirm these changes' })).not.toBeInTheDocument();
    expect(api.updateR1Settings).not.toHaveBeenCalled();

    await user.click(save());
    await screen.findByRole('group', { name: 'Confirm these changes' });
    await user.click(toggle('Paused'));
    expect(screen.queryByRole('group', { name: 'Confirm these changes' })).not.toBeInTheDocument();
  });
});

describe('server refusals', () => {
  it.each([
    [400, /rejected those values/],
    [403, /Only an admin can change R1 settings/],
    [503, /could not be saved\. Nothing was changed/],
  ])('explains a %i without losing the edit', async (status, words) => {
    api.updateR1Settings.mockRejectedValue(new ApiError('invalid_r1_settings', status));
    const user = userEvent.setup();
    renderPage();
    await loaded();
    await user.click(toggle('Paused'));
    await user.click(save());
    expect(await screen.findByRole('alert')).toHaveTextContent(words);
    expect(toggle('Paused')).toHaveAttribute('aria-checked', 'true');
    expect(save()).toBeEnabled();
  });
});

describe('the dashboard reading', () => {
  it('says no reading exists yet', async () => {
    renderPage();
    await loaded();
    expect(screen.getByText('No reading has been recorded yet.')).toBeInTheDocument();
  });

  it('shows the current reading exactly, with decimals', async () => {
    api.getR1Settings.mockResolvedValue({
      ...SAVED,
      dashboard_minutes: 1234.5,
      dashboard_read_at: new Date().toISOString(),
    });
    renderPage();
    await loaded();
    expect(screen.getByText(/Current reading: 1,234\.5 min, read/)).toBeInTheDocument();
    expect(screen.queryByText(/but the capacity guard still counts it/)).not.toBeInTheDocument();
  });

  describe('a reading from an earlier month (P3)', () => {
    it('is flagged, because the guard keeps counting it until a new one is recorded', async () => {
      api.getR1Settings.mockResolvedValue({
        ...SAVED,
        dashboard_minutes: 3900,
        dashboard_read_at: '2020-09-30T20:00:00.000Z',
      });
      renderPage();
      await loaded();
      const notice = screen.getByText(/This reading is from September 2020/);
      expect(notice).toHaveTextContent(/the capacity guard still counts it this month/);
      expect(notice).toHaveTextContent('Record this month’s reading.');
      expect(notice.closest('[role="status"]')).not.toBeNull();
    });

    it('is not flagged on the r1 target, where the Cloud pool gates no send', async () => {
      api.getR1Settings.mockResolvedValue({
        ...SAVED,
        livekit_target: 'r1',
        dashboard_minutes: 3900,
        dashboard_read_at: '2020-09-30T20:00:00.000Z',
      });
      renderPage();
      await loaded();
      expect(screen.getByText(/Current reading: 3,900 min, read/)).toBeInTheDocument();
      expect(screen.queryByText(/This reading is from/)).not.toBeInTheDocument();
    });

    it('is no longer flagged once this month’s reading is recorded', async () => {
      api.getR1Settings.mockResolvedValue({
        ...SAVED,
        dashboard_minutes: 3900,
        dashboard_read_at: '2020-09-30T20:00:00.000Z',
      });
      const user = userEvent.setup();
      renderPage();
      await loaded();
      expect(screen.getByText(/This reading is from September 2020/)).toBeInTheDocument();
      await user.type(field('New reading (minutes)'), '120');
      await user.click(screen.getByRole('button', { name: 'Record reading' }));
      await screen.findByText('Dashboard reading recorded.');
      expect(screen.queryByText(/This reading is from/)).not.toBeInTheDocument();
    });

    it('has no axe violations while the notice shows', async () => {
      api.getR1Settings.mockResolvedValue({
        ...SAVED,
        dashboard_minutes: 3900,
        dashboard_read_at: '2020-09-30T20:00:00.000Z',
      });
      const { container } = renderPage();
      await loaded();
      await screen.findByText(/This reading is from September 2020/);
      await expect(container).toHaveNoViolations();
    });
  });

  it('records minutes with the moment recorded, which the API does not stamp itself', async () => {
    const user = userEvent.setup();
    renderPage();
    await loaded();
    const before = Date.now();
    await user.type(field('New reading (minutes)'), '1234.5');
    await user.click(screen.getByRole('button', { name: 'Record reading' }));

    await waitFor(() => expect(api.updateR1Settings).toHaveBeenCalledTimes(1));
    const [patch] = api.updateR1Settings.mock.calls[0] as [
      { dashboard_minutes: number; dashboard_read_at: string },
    ];
    expect(patch.dashboard_minutes).toBe(1234.5);
    expect(Object.keys(patch).sort()).toEqual(['dashboard_minutes', 'dashboard_read_at']);
    expect(Date.parse(patch.dashboard_read_at)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(patch.dashboard_read_at)).toBeLessThanOrEqual(Date.now() + 1000);
    expect(await screen.findByText('Dashboard reading recorded.')).toBeInTheDocument();
    expect(field('New reading (minutes)')).toHaveValue('');
  });

  it('rejects a malformed reading, explains it and focuses the field', async () => {
    const user = userEvent.setup();
    renderPage();
    await loaded();
    await user.type(field('New reading (minutes)'), '12,3');
    await user.click(screen.getByRole('button', { name: 'Record reading' }));
    expect(api.updateR1Settings).not.toHaveBeenCalled();
    expect(field('New reading (minutes)')).toHaveFocus();
    expect(screen.getByText(/Enter the month-to-date minutes/)).toHaveAttribute('role', 'alert');
  });

  it('keeps unsaved edits in the main form when a reading is recorded', async () => {
    const user = userEvent.setup();
    renderPage();
    await loaded();
    await user.click(toggle('Paused'));
    await user.type(field('New reading (minutes)'), '99');
    await user.click(screen.getByRole('button', { name: 'Record reading' }));
    await screen.findByText('Dashboard reading recorded.');
    expect(toggle('Paused')).toHaveAttribute('aria-checked', 'true');
    // And that edit is still the only thing a later Save would send.
    await user.click(save());
    expect(api.updateR1Settings).toHaveBeenLastCalledWith({ paused: true });
  });

  describe('another admin changed the settings while this page was open (P2)', () => {
    /** The PUT for a reading returns the CURRENT row, which another admin has since changed. */
    function otherAdminChanged(changes: Record<string, unknown>) {
      api.updateR1Settings.mockImplementationOnce(async (patch: Record<string, unknown>) => ({
        ...SAVED,
        ...changes,
        ...patch,
        updated_at: '2026-10-06T11:00:00.000Z',
      }));
    }

    it('follows their pause instead of turning dirty, and never sends paused:false', async () => {
      otherAdminChanged({ paused: true });
      const user = userEvent.setup();
      renderPage();
      await loaded();
      expect(toggle('Paused')).toHaveAttribute('aria-checked', 'false');

      await user.type(field('New reading (minutes)'), '99');
      await user.click(screen.getByRole('button', { name: 'Record reading' }));
      await screen.findByText('Dashboard reading recorded.');

      // The form shows the pause the other admin set, and nothing is waiting to be saved.
      expect(toggle('Paused')).toHaveAttribute('aria-checked', 'true');
      expect(save()).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Discard changes' })).toBeDisabled();

      // A later, unrelated edit sends only that edit: the pause is left alone.
      await user.clear(field('Hold threshold'));
      await user.type(field('Hold threshold'), '40');
      await user.click(save());
      await waitFor(() => expect(api.updateR1Settings).toHaveBeenCalledTimes(2));
      expect(api.updateR1Settings).toHaveBeenLastCalledWith({ hold_threshold: 40 });
    });

    it('keeps the person’s own unsaved edit and follows the other admin on the rest', async () => {
      otherAdminChanged({ paused: true, monthly_cap_minutes: 3000 });
      const user = userEvent.setup();
      renderPage();
      await loaded();
      await user.clear(field('Advance threshold'));
      await user.type(field('Advance threshold'), '70');

      await user.type(field('New reading (minutes)'), '99');
      await user.click(screen.getByRole('button', { name: 'Record reading' }));
      await screen.findByText('Dashboard reading recorded.');

      expect(field('Advance threshold')).toHaveValue('70');
      expect(field('Monthly cap (minutes)')).toHaveValue('3000');
      expect(toggle('Paused')).toHaveAttribute('aria-checked', 'true');
      await user.click(save());
      await waitFor(() => expect(api.updateR1Settings).toHaveBeenCalledTimes(2));
      expect(api.updateR1Settings).toHaveBeenLastCalledWith({ advance_threshold: 70 });
    });

    it('does not let Save lift a pause the page never showed as lifted', async () => {
      // The finding's exact sequence, ending in a Save of the person's own, different edit.
      otherAdminChanged({ paused: true });
      const user = userEvent.setup();
      renderPage();
      await loaded();
      await user.type(field('New reading (minutes)'), '99');
      await user.click(screen.getByRole('button', { name: 'Record reading' }));
      await screen.findByText('Dashboard reading recorded.');
      await user.click(toggle('Automatic status changes'));
      await user.click(save());
      await user.click(await screen.findByRole('button', { name: 'Confirm and save' }));
      await waitFor(() => expect(api.updateR1Settings).toHaveBeenCalledTimes(2));
      const sent = api.updateR1Settings.mock.calls[1]![0] as Record<string, unknown>;
      expect(sent).toEqual({ auto_status_enabled: true });
      expect(sent).not.toHaveProperty('paused');
    });

    it('closes an open confirmation, whose reasons were worked out from the old row', async () => {
      otherAdminChanged({ paused: true });
      const user = userEvent.setup();
      renderPage();
      await loaded();
      await user.click(toggle('R1 enabled'));
      await user.click(save());
      await screen.findByRole('group', { name: 'Confirm these changes' });
      await user.type(field('New reading (minutes)'), '99');
      await user.click(screen.getByRole('button', { name: 'Record reading' }));
      await screen.findByText('Dashboard reading recorded.');
      expect(
        screen.queryByRole('group', { name: 'Confirm these changes' }),
      ).not.toBeInTheDocument();
      // The edit itself survives, ready to be confirmed again.
      expect(toggle('R1 enabled')).toHaveAttribute('aria-checked', 'true');
    });
  });

  it('says so when the reading cannot be saved', async () => {
    api.updateR1Settings.mockRejectedValue(new ApiError('boom', 503));
    const user = userEvent.setup();
    renderPage();
    await loaded();
    await user.type(field('New reading (minutes)'), '10');
    await user.click(screen.getByRole('button', { name: 'Record reading' }));
    expect(await screen.findByText(/The reading could not be saved/)).toBeInTheDocument();
  });
});

describe('accessibility', () => {
  it('has no axe violations when loaded', async () => {
    const { container } = renderPage();
    await loaded();
    await expect(container).toHaveNoViolations();
  });

  it('has no axe violations with validation errors showing', async () => {
    const user = userEvent.setup();
    const { container } = renderPage();
    await loaded();
    await user.clear(field('Monthly cap (minutes)'));
    await user.clear(field('Hold threshold'));
    await user.click(save());
    await screen.findAllByRole('alert');
    await expect(container).toHaveNoViolations();
  });

  it('has no axe violations with the confirmation open', async () => {
    const user = userEvent.setup();
    const { container } = renderPage();
    await loaded();
    await user.click(toggle('R1 enabled'));
    await user.click(save());
    await screen.findByRole('group', { name: 'Confirm these changes' });
    await expect(container).toHaveNoViolations();
  });

  it('has no axe violations for the non-admin panel', async () => {
    api.getR1Settings.mockRejectedValue(new ApiError('x', 403));
    const { container } = renderPage();
    await screen.findByText(/Admin access required/);
    await expect(container).toHaveNoViolations();
  });
});
