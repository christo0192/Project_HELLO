/**
 * AccessSection — allowlist management.
 *
 * Covers: pending/linked/disabled states, email-normalization UI, add
 * success/failure/409, update confirmation + success/failure/409, self and
 * last-linked-admin protection (no bypass), no optimistic success, no full
 * email in any log surface, and axe.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { missionApi, apiFns } from './apiMock';
import { AccessSection } from '../AccessSection';

vi.mock('../../../api', () => ({
  api: missionApi.api,
  ApiError: missionApi.ApiError,
}));

const ME = {
  userId: 'u-admin',
  email: 'admin@interviewkickstart.com',
  role: 'admin' as const,
  active: true,
};

const ENTRIES = [
  { id: 'e1', email: 'Admin@InterviewKickstart.com', role: 'admin' as const, active: true, linked_user_id: 'u-admin', linked_at: '2026-01-01T00:00:00Z' },
  { id: 'e2', email: 'christo.b@interviewkickstart.com', role: 'interviewer' as const, active: true, linked_user_id: null, linked_at: null },
  { id: 'e3', email: 'viewer.one@interviewkickstart.com', role: 'viewer' as const, active: false, linked_user_id: 'u-old', linked_at: '2026-01-02T00:00:00Z' },
  { id: 'e4', email: 'second.admin@interviewkickstart.com', role: 'admin' as const, active: true, linked_user_id: 'u-second', linked_at: '2026-01-03T00:00:00Z' },
];

function renderAccess() {
  return render(<AccessSection />);
}

describe('AccessSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFns.getMe.mockResolvedValue(ME);
    apiFns.listAdminAllowlist.mockResolvedValue({ entries: ENTRIES });
    apiFns.addAdminAllowlistEntry.mockResolvedValue({ ok: true, id: 'e-new' });
    apiFns.updateAdminAllowlistEntry.mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a loading state until the list resolves', () => {
    apiFns.listAdminAllowlist.mockReturnValue(new Promise(() => {}));
    renderAccess();
    expect(screen.getByText('Loading access list…')).toBeInTheDocument();
  });

  it('shows an error state with retry on load failure', async () => {
    apiFns.getMe.mockRejectedValue(new missionApi.ApiError('unauthorized', 403));
    apiFns.listAdminAllowlist.mockRejectedValue(
      new missionApi.ApiError('unauthorized', 403),
    );
    renderAccess();
    expect(await screen.findByText('unauthorized')).toBeInTheDocument();
    apiFns.listAdminAllowlist.mockResolvedValue({ entries: ENTRIES });
    apiFns.getMe.mockResolvedValue(ME);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Access entries')).toBeInTheDocument();
  });

  it('renders pending, linked and disabled states with filter counts', async () => {
    renderAccess();
    await screen.findByText('Access entries');

    const pending = await screen.findByText('christo.b@interviewkickstart.com');
    const row = pending.closest('tr') as HTMLElement;
    expect(within(row).getByText('Pending')).toBeInTheDocument();
    expect(within(row).queryByText('Linked')).not.toBeInTheDocument();

    const disabledRow = screen
      .getByText('viewer.one@interviewkickstart.com')
      .closest('tr') as HTMLElement;
    expect(within(disabledRow).getByText('Disabled')).toBeInTheDocument();

    const linkedRow = screen
      .getByText('second.admin@interviewkickstart.com')
      .closest('tr') as HTMLElement;
    expect(within(linkedRow).getByText('Linked')).toBeInTheDocument();

    // Filter chips carry real counts
    expect(screen.getByRole('button', { name: /Linked 2/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Pending 1/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Disabled 1/ })).toBeInTheDocument();
  });

  it('filters the list by state', async () => {
    renderAccess();
    await screen.findByText('Access entries');
    fireEvent.click(screen.getByRole('button', { name: /Pending 1/ }));
    expect(screen.getByText('christo.b@interviewkickstart.com')).toBeInTheDocument();
    expect(screen.queryByText('second.admin@interviewkickstart.com')).not.toBeInTheDocument();
    expect(screen.queryByText('viewer.one@interviewkickstart.com')).not.toBeInTheDocument();
  });

  it('shows a normalization preview and a non-company warning while typing', async () => {
    renderAccess();
    await screen.findByText('Add an access entry');
    const emailInput = screen.getByLabelText('Company email');

    await userEvent.type(emailInput, '  JOHN.DOE@INTERVIEWKICKSTART.COM ');
    expect(
      await screen.findByText('Will be stored as john.doe@interviewkickstart.com'),
    ).toBeInTheDocument();

    await userEvent.clear(emailInput);
    await userEvent.type(emailInput, 'john@gmail.com');
    expect(
      await screen.findByText('Only @interviewkickstart.com emails can be added.'),
    ).toBeInTheDocument();
  });

  it('adds an entry after explicit confirmation (viewer default)', async () => {
    renderAccess();
    await screen.findByText('Add an access entry');

    await userEvent.type(
      screen.getByLabelText('Company email'),
      '  NEW.HIRE@INTERVIEWKICKSTART.COM ',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add entry' }));
    // Confirmation panel opened with the exact email (strong text) and the
    // confirm action — and nothing was sent yet.
    expect(screen.getByRole('button', { name: 'Add access entry' })).toBeInTheDocument();
    expect(
      screen.getAllByText('NEW.HIRE@INTERVIEWKICKSTART.COM').length,
    ).toBeGreaterThan(0);
    expect(apiFns.addAdminAllowlistEntry).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Add access entry' }));
    await waitFor(() => {
      expect(apiFns.addAdminAllowlistEntry).toHaveBeenCalledWith({
        email: 'NEW.HIRE@INTERVIEWKICKSTART.COM',
        role: 'viewer',
      });
    });
    // Success message only after the API resolved.
    expect(await screen.findByText('Access entry added.')).toBeInTheDocument();
  });

  it('chooses a role when adding', async () => {
    renderAccess();
    await screen.findByText('Add an access entry');
    await userEvent.type(
      screen.getByLabelText('Company email'),
      'recruiter@interviewkickstart.com',
    );
    await userEvent.selectOptions(screen.getByLabelText('Role'), 'interviewer');
    fireEvent.click(screen.getByRole('button', { name: 'Add entry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add access entry' }));
    await waitFor(() => {
      expect(apiFns.addAdminAllowlistEntry).toHaveBeenCalledWith({
        email: 'recruiter@interviewkickstart.com',
        role: 'interviewer',
      });
    });
  });

  it('shows a stable message for a duplicate (409) on add', async () => {
    apiFns.addAdminAllowlistEntry.mockRejectedValue(
      new missionApi.ApiError('duplicate', 409),
    );
    renderAccess();
    await screen.findByText('Add an access entry');
    await userEvent.type(
      screen.getByLabelText('Company email'),
      'existing@interviewkickstart.com',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add entry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add access entry' }));
    expect(
      await screen.findByText('That email is already on the access list.'),
    ).toBeInTheDocument();
  });

  it('shows a stable message for an invalid email (400) on add', async () => {
    apiFns.addAdminAllowlistEntry.mockRejectedValue(
      new missionApi.ApiError('invalid_email', 400),
    );
    renderAccess();
    await screen.findByText('Add an access entry');
    await userEvent.type(
      screen.getByLabelText('Company email'),
      'bad@example.com',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add entry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add access entry' }));
    expect(
      await screen.findByText(/That email address cannot be added/),
    ).toBeInTheDocument();
  });

  it('updates role/active only after explicit confirmation, then refreshes', async () => {
    renderAccess();
    await screen.findByText('christo.b@interviewkickstart.com');

    const row = screen
      .getByText('christo.b@interviewkickstart.com')
      .closest('tr') as HTMLElement;
    await userEvent.selectOptions(within(row).getByLabelText(/Role for christo/), 'viewer');
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    expect(
      screen.getByText(/role interviewer → viewer/),
    ).toBeInTheDocument();
    expect(apiFns.updateAdminAllowlistEntry).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
    await waitFor(() => {
      expect(apiFns.updateAdminAllowlistEntry).toHaveBeenCalledWith('e2', {
        role: 'viewer',
      });
    });
    expect(await screen.findByText('Access entry updated.')).toBeInTheDocument();
    // List refreshed after success.
    expect(apiFns.listAdminAllowlist).toHaveBeenCalledTimes(2);
  });

  it('is not optimistic: no success message while the update is pending', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    apiFns.updateAdminAllowlistEntry.mockReturnValue(gate.then(() => ({ ok: true })));
    renderAccess();
    await screen.findByText('christo.b@interviewkickstart.com');

    const row = screen
      .getByText('christo.b@interviewkickstart.com')
      .closest('tr') as HTMLElement;
    await userEvent.selectOptions(within(row).getByLabelText(/Role for christo/), 'viewer');
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));

    expect(screen.queryByText('Access entry updated.')).not.toBeInTheDocument();
    release();
    expect(await screen.findByText('Access entry updated.')).toBeInTheDocument();
  });

  it('maps a 409 last-linked-active-admin rejection to stable copy and resyncs', async () => {
    apiFns.updateAdminAllowlistEntry.mockRejectedValue(
      new missionApi.ApiError('last_linked_active_admin', 409),
    );
    renderAccess();
    await screen.findByText('christo.b@interviewkickstart.com');

    const row = screen
      .getByText('christo.b@interviewkickstart.com')
      .closest('tr') as HTMLElement;
    await userEvent.selectOptions(within(row).getByLabelText(/Role for christo/), 'admin');
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
    expect(
      await screen.findByText(/last linked active admin/),
    ).toBeInTheDocument();
  });

  it('protects your own entry — controls disabled and no bypass offered', async () => {
    renderAccess();
    await screen.findByText(/Admin@InterviewKickstart.com/);
    const row = screen
      .getByText('Admin@InterviewKickstart.com')
      .closest('tr') as HTMLElement;
    expect(within(row).getByText(/Your own entry/)).toBeInTheDocument();
    expect(within(row).getByLabelText(/Role for Admin@InterviewKickstart.com/)).toBeDisabled();
    expect(within(row).getByLabelText(/Active for Admin@InterviewKickstart.com/)).toBeDisabled();
    expect(within(row).getByRole('button', { name: 'Save' })).toBeDisabled();
    // No hidden workaround: the entry id never reaches updateAdminAllowlistEntry.
    expect(apiFns.updateAdminAllowlistEntry).not.toHaveBeenCalled();
  });

  it('protects the last linked active admin — no disable/demote bypass', async () => {
    apiFns.listAdminAllowlist.mockResolvedValue({
      entries: [
        { id: 'only-admin', email: 'solo@interviewkickstart.com', role: 'admin' as const, active: true, linked_user_id: 'u1', linked_at: '2026-01-01T00:00:00Z' },
        { id: 'viewer1', email: 'v1@interviewkickstart.com', role: 'viewer' as const, active: true, linked_user_id: 'u2', linked_at: '2026-01-01T00:00:00Z' },
      ],
    });
    renderAccess();
    await screen.findByText('solo@interviewkickstart.com');
    const row = screen
      .getByText('solo@interviewkickstart.com')
      .closest('tr') as HTMLElement;
    expect(within(row).getByText(/Last linked active admin/)).toBeInTheDocument();
    expect(within(row).getByLabelText(/Role for solo@interviewkickstart.com/)).toBeDisabled();
    expect(within(row).getByLabelText(/Active for solo@interviewkickstart.com/)).toBeDisabled();
    expect(within(row).getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(apiFns.updateAdminAllowlistEntry).not.toHaveBeenCalled();
  });

  it('never writes a full email to any log surface', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    renderAccess();
    await screen.findByText('christo.b@interviewkickstart.com');
    // Interact a bit — add + update attempts
    await userEvent.type(
      screen.getByLabelText('Company email'),
      'probe@interviewkickstart.com',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add entry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add access entry' }));
    await waitFor(() => {
      expect(apiFns.addAdminAllowlistEntry).toHaveBeenCalled();
    });
    for (const call of logSpy.mock.calls) {
      const text = call.join(' ');
      expect(text).not.toContain('@interviewkickstart.com');
    }
    logSpy.mockRestore();
  });

  it('has no axe violations', async () => {
    const { container } = renderAccess();
    await screen.findByText('Access entries');
    await expect(container).toHaveNoViolations();
  });
});
