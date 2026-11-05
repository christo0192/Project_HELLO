/**
 * SessionsSection — bounded admin session view + confirmed override.
 * Covers: filter, response-confirmed updates (no optimism), terminal-state
 * locking (no resurrection), stable 400/409 copy, no PII, axe.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { missionApi, apiFns } from './apiMock';
import { SessionsSection } from '../SessionsSection';

vi.mock('../../../api', () => ({
  api: missionApi.api,
  ApiError: missionApi.ApiError,
}));

const SESSIONS = [
  { id: '00000000-0000-4000-8000-000000000001', candidate_id: 'cand-1111-2222-3333-4444', role_id: null, status: 'waiting', created_at: '2026-01-01T00:00:00Z', started_at: null, ended_at: null },
  { id: '00000000-0000-4000-8000-000000000002', candidate_id: 'cand-aaaa-bbbb-cccc-dddd', role_id: null, status: 'failed', created_at: '2026-01-02T00:00:00Z', started_at: '2026-01-02T00:01:00Z', ended_at: '2026-01-02T00:05:00Z' },
  { id: '00000000-0000-4000-8000-000000000003', candidate_id: 'cand-1111-2222-3333-4444', role_id: null, status: 'completed', created_at: '2026-01-03T00:00:00Z', started_at: '2026-01-03T00:01:00Z', ended_at: '2026-01-03T00:30:00Z' },
];

function renderSessions() {
  return render(<SessionsSection />);
}

describe('SessionsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFns.listAdminSessions.mockResolvedValue({ sessions: SESSIONS });
    apiFns.overrideSession.mockResolvedValue({ ok: true, prior_status: 'waiting' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a loading state until sessions resolve', () => {
    apiFns.listAdminSessions.mockReturnValue(new Promise(() => {}));
    renderSessions();
    expect(screen.getByText('Loading sessions…')).toBeInTheDocument();
  });

  it('shows an error state with a retry action', async () => {
    apiFns.listAdminSessions.mockRejectedValue(new missionApi.ApiError('unauthorized', 403));
    renderSessions();
    expect(await screen.findByText(/your session has ended/i)).toBeInTheDocument();
    expect(screen.queryByText('unauthorized')).not.toBeInTheDocument();
    apiFns.listAdminSessions.mockResolvedValue({ sessions: SESSIONS });
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Sessions')).toBeInTheDocument();
  });

  it('renders the session table with opaque ids only (no candidate PII)', async () => {
    renderSessions();
    await screen.findByText('Sessions');
    const rows = screen.getAllByRole('row');
    expect(rows.length).toBe(4); // header + 3
    // Raw full UUIDs are never rendered — only short opaque ids.
    expect(
      screen.queryByText('00000000-0000-4000-8000-000000000001'),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText('Waiting').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Failed').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Completed').length).toBeGreaterThan(0);
    // Candidate ids are opaque short ids — full raw uuids and names are
    // never rendered.
    expect(
      screen.queryByText('cand-1111-2222-3333-4444'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/@example\.com/)).not.toBeInTheDocument();
  });

  it('calls a short list a total, and adds nothing about a cut', async () => {
    apiFns.listAdminSessions.mockResolvedValue({ sessions: SESSIONS, truncated: false });
    renderSessions();
    expect(await screen.findByText('3 total · 1 terminal')).toBeInTheDocument();
    expect(screen.queryByText(/most recently updated/)).not.toBeInTheDocument();
  });

  it('never calls a cut page a total, and says the table holds fewer still', async () => {
    // GET /api/admin/sessions answers at most 100 rows and no total: at 5,000
    // sessions, "100 total" would be false.
    const page = Array.from({ length: 100 }, (_, i) => ({
      ...SESSIONS[0],
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      status: i < 34 ? 'failed' : 'waiting',
    }));
    apiFns.listAdminSessions.mockResolvedValue({ sessions: page, truncated: true });
    renderSessions();
    expect(await screen.findByText('The 100 most recently updated · 34 terminal')).toBeInTheDocument();
    expect(screen.queryByText(/\btotal\b/)).not.toBeInTheDocument();
    expect(
      screen.getByText(/hold the 50 most recently updated\. Older sessions cannot be overridden from here\./),
    ).toBeInTheDocument();
    expect(within(screen.getByLabelText('Session')).getAllByRole('option')).toHaveLength(50);
  });

  it('says the table bound when a whole list of more than 50 does not fit it', async () => {
    const page = Array.from({ length: 60 }, (_, i) => ({
      ...SESSIONS[0],
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    }));
    apiFns.listAdminSessions.mockResolvedValue({ sessions: page, truncated: false });
    renderSessions();
    expect(await screen.findByText('60 total · 0 terminal')).toBeInTheDocument();
    expect(screen.getByText(/hold the 50 most recently updated/)).toBeInTheDocument();
  });

  it('filters by status via the select', async () => {
    renderSessions();
    await screen.findByText('Sessions');
    await userEvent.selectOptions(screen.getByLabelText('Status filter'), 'completed');
    await waitFor(() => {
      expect(apiFns.listAdminSessions).toHaveBeenLastCalledWith('completed');
    });
  });

  it('applies an override only after confirmation, with a required reason', async () => {
    renderSessions();
    await screen.findByText('Override session status');

    // No reason → Apply disabled.
    const apply = screen.getByRole('button', { name: 'Apply override' });
    expect(apply).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Reason (required)'), 'Call completed off-hook');
    fireEvent.click(screen.getByRole('button', { name: 'Apply override' }));
    expect(apiFns.overrideSession).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Reason: “Call completed off-hook”/),
    ).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Target status'), 'completed');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm override' }));
    await waitFor(() => {
      expect(apiFns.overrideSession).toHaveBeenCalledWith(
        '00000000-0000-4000-8000-000000000001',
        { target_status: 'completed', reason: 'Call completed off-hook' },
      );
    });
    // Response-confirmed message reflects the response's prior_status.
    expect(
      await screen.findByText('Session updated to completed (was waiting).'),
    ).toBeInTheDocument();
  });

  it('is not optimistic: no confirmation message while the override is pending', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    apiFns.overrideSession.mockReturnValue(
      gate.then(() => ({ ok: true, prior_status: 'waiting' })),
    );
    renderSessions();
    await screen.findByText('Override session status');
    await userEvent.type(screen.getByLabelText('Reason (required)'), 'reason');
    fireEvent.click(screen.getByRole('button', { name: 'Apply override' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm override' }));
    expect(screen.queryByText(/Session updated/)).not.toBeInTheDocument();
    release();
    expect(await screen.findByText(/Session updated to waiting/)).toBeInTheDocument();
  });

  it('locks the override form for terminal sessions — no resurrection offered', async () => {
    renderSessions();
    await screen.findByText('Override session status');

    await userEvent.selectOptions(
      screen.getByLabelText('Session'),
      '00000000-0000-4000-8000-000000000002',
    );
    expect(
      screen.getByText(/terminal state \(Failed\) and cannot be changed/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Session')).toBeDisabled();
    expect(screen.getByLabelText('Target status')).toBeDisabled();
    expect(screen.getByLabelText('Reason (required)')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Apply override' })).not.toBeInTheDocument();
  });

  it('maps a 409 resurrection rejection to stable copy', async () => {
    apiFns.overrideSession.mockRejectedValue(
      new missionApi.ApiError('resurrection_denied', 409),
    );
    renderSessions();
    await screen.findByText('Override session status');
    await userEvent.type(screen.getByLabelText('Reason (required)'), 'trying');
    fireEvent.click(screen.getByRole('button', { name: 'Apply override' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm override' }));
    expect(
      await screen.findByText(/Sessions in a terminal state .* cannot be changed/i),
    ).toBeInTheDocument();
  });

  it('shows a truthful empty state for an empty filter result', async () => {
    apiFns.listAdminSessions.mockResolvedValue({ sessions: [] });
    renderSessions();
    expect(await screen.findByText('No sessions found')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = renderSessions();
    await screen.findByText('Override session status');
    await userEvent.selectOptions(
      screen.getByLabelText('Session'),
      '00000000-0000-4000-8000-000000000003',
    );
    await expect(container).toHaveNoViolations();
  });
});
