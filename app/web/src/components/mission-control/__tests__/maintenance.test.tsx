/**
 * MaintenanceSection — current state + confirmed toggle.
 * Covers: truthful state rendering, explicit confirmation, no optimistic
 * success, required reason, stable 400 copy, axe.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { missionApi, apiFns } from './apiMock';
import { MaintenanceSection } from '../MaintenanceSection';

vi.mock('../../../api', () => ({
  api: missionApi.api,
  ApiError: missionApi.ApiError,
}));

const OK_STATUS = {
  status: 'ok' as const,
  maintenance: { enabled: false, reason: null, updated_at: null },
  updated_at: '2026-01-01T00:00:00Z',
};

const MAINT_STATUS = {
  status: 'maintenance' as const,
  maintenance: {
    enabled: true,
    reason: 'Deployment window',
    updated_at: '2026-01-01T01:00:00Z',
  },
  updated_at: '2026-01-01T02:00:00Z',
};

function renderMaintenance() {
  return render(<MaintenanceSection />);
}

describe('MaintenanceSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFns.status.mockResolvedValue(OK_STATUS);
    apiFns.toggleMaintenance.mockResolvedValue({ ok: true, enabled: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a loading state until status resolves', () => {
    apiFns.status.mockReturnValue(new Promise(() => {}));
    renderMaintenance();
    expect(screen.getByText('Loading maintenance state…')).toBeInTheDocument();
  });

  it('renders the current state truthfully from the status response', async () => {
    apiFns.status.mockResolvedValue(MAINT_STATUS);
    renderMaintenance();
    await screen.findByText('Current state');
    expect(screen.getByText('Maintenance mode')).toBeInTheDocument();
    expect(screen.getByText('Deployment window')).toBeInTheDocument();
    // The toggle mirrors the response (enabled pre-checked).
    expect(screen.getByLabelText('Enable maintenance (block new sessions)')).toBeChecked();
  });

  it('renders an operational state when maintenance is off', async () => {
    renderMaintenance();
    await screen.findByText('Current state');
    expect(screen.getByText('Operational')).toBeInTheDocument();
    expect(screen.queryByText('Maintenance mode')).not.toBeInTheDocument();
  });

  it('requires a reason and applies the toggle only after explicit confirmation', async () => {
    renderMaintenance();
    await screen.findByText('Current state');

    // Choose to ENABLE maintenance (checkbox starts unchecked = off).
    fireEvent.click(screen.getByLabelText('Enable maintenance (block new sessions)'));
    const apply = screen.getByRole('button', { name: 'Apply change' });
    expect(apply).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Reason (required)'), 'Planned window');
    fireEvent.click(screen.getByRole('button', { name: 'Apply change' }));
    expect(
      screen.getByText(/Enable maintenance mode\? Reason: “Planned window”/),
    ).toBeInTheDocument();
    expect(apiFns.toggleMaintenance).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
    await waitFor(() => {
      expect(apiFns.toggleMaintenance).toHaveBeenCalledWith({
        enabled: true,
        reason: 'Planned window',
      });
    });
    // Success message is response-derived (not optimistic).
    expect(await screen.findByText('Maintenance is now enabled.')).toBeInTheDocument();
  });

  it('disables maintenance after confirmation with a response-derived message', async () => {
    apiFns.toggleMaintenance.mockResolvedValue({ ok: true, enabled: false });
    apiFns.status.mockResolvedValue(MAINT_STATUS);
    renderMaintenance();
    await screen.findByText('Current state');

    await userEvent.type(screen.getByLabelText('Reason (required)'), 'Window complete');
    fireEvent.click(screen.getByRole('button', { name: 'Apply change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
    expect(await screen.findByText('Maintenance is now disabled.')).toBeInTheDocument();
    // State re-read from the API after the change.
    await waitFor(() => {
      expect(apiFns.status).toHaveBeenCalledTimes(2);
    });
  });

  it('is not optimistic: no success message while the toggle is pending', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    apiFns.toggleMaintenance.mockReturnValue(gate.then(() => ({ ok: true, enabled: true })));
    renderMaintenance();
    await screen.findByText('Current state');
    await userEvent.type(screen.getByLabelText('Reason (required)'), 'reason');
    fireEvent.click(screen.getByRole('button', { name: 'Apply change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
    expect(screen.queryByText(/Maintenance is now/)).not.toBeInTheDocument();
    release();
    expect(await screen.findByText('Maintenance is now enabled.')).toBeInTheDocument();
  });

  it('maps a 400 invalid_reason rejection to stable copy', async () => {
    apiFns.toggleMaintenance.mockRejectedValue(
      new missionApi.ApiError('invalid_reason', 400),
    );
    renderMaintenance();
    await screen.findByText('Current state');
    await userEvent.type(screen.getByLabelText('Reason (required)'), 'x');
    fireEvent.click(screen.getByRole('button', { name: 'Apply change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
    expect(
      await screen.findByText('A reason is required for this change.'),
    ).toBeInTheDocument();
  });

  it('shows an error state with retry when status fails', async () => {
    apiFns.status.mockRejectedValue(new missionApi.ApiError('down', 500));
    renderMaintenance();
    expect(await screen.findByText('down')).toBeInTheDocument();
    apiFns.status.mockResolvedValue(OK_STATUS);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Current state')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = renderMaintenance();
    await screen.findByText('Current state');
    await expect(container).toHaveNoViolations();
  });
});
