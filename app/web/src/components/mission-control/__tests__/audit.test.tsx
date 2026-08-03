/**
 * AuditSection — bounded, redacted audit view.
 * Covers: only-bounded-fields rendering (metadata/emails never reach the
 * DOM), bounded pagination, loading/error/retry, empty state, axe.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AdminAuditRow } from '../../../types';
import { missionApi, apiFns } from './apiMock';
import { AuditSection } from '../AuditSection';

vi.mock('../../../api', () => ({
  api: missionApi.api,
  ApiError: missionApi.ApiError,
}));

const ROW: AdminAuditRow = {
  id: 'audit-1',
  action: 'admin_maintenance_toggle',
  actor_type: 'recruiter',
  actor_id: 'actor-user-0000-0000-000000000001',
  target_type: 'system',
  target_id: 'maintenance',
  result: 'success',
  created_at: '2026-01-01T00:00:00Z',
};

function renderAudit() {
  return render(<AuditSection />);
}

describe('AuditSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFns.listAdminAudit.mockResolvedValue({ audit: [ROW] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a loading state until the page resolves', () => {
    apiFns.listAdminAudit.mockReturnValue(new Promise(() => {}));
    renderAudit();
    expect(screen.getByText('Loading audit log…')).toBeInTheDocument();
  });

  it('shows an error state with a retry action', async () => {
    apiFns.listAdminAudit.mockRejectedValue(new missionApi.ApiError('unauthorized', 403));
    renderAudit();
    expect(await screen.findByText('unauthorized')).toBeInTheDocument();
    apiFns.listAdminAudit.mockResolvedValue({ audit: [ROW] });
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('admin_maintenance_toggle')).toBeInTheDocument();
  });

  it('renders only the bounded redacted fields', async () => {
    renderAudit();
    await screen.findByText('admin_maintenance_toggle');
    expect(screen.getByText('recruiter')).toBeInTheDocument();
    expect(screen.getByText('system')).toBeInTheDocument();
    expect(screen.getByText('success')).toBeInTheDocument();
    // Ids are short/opaque — the full actor id is never rendered.
    expect(
      screen.queryByText('actor-user-0000-0000-000000000001'),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/^actor-user-/)).toBeInTheDocument();
  });

  it('never renders arbitrary metadata, IPs, tokens or emails — even if the payload contains them', async () => {
    const leaky = {
      ...ROW,
      // Hypothetical leaky fields a broken server might include:
      metadata: {
        reason: 'top-secret-reason',
        source_ip: '10.0.0.42',
        trace_id: 'trace-abc',
      },
      correlation_id: 'corr-xyz',
      token: 'opaque-jwt-value',
      email: 'private@interviewkickstart.com',
    } as AdminAuditRow;
    apiFns.listAdminAudit.mockResolvedValue({ audit: [leaky] });
    renderAudit();
    await screen.findByText('admin_maintenance_toggle');
    expect(screen.queryByText('top-secret-reason')).not.toBeInTheDocument();
    expect(screen.queryByText(/10\.0\.0\./)).not.toBeInTheDocument();
    expect(screen.queryByText('trace-abc')).not.toBeInTheDocument();
    expect(screen.queryByText('corr-xyz')).not.toBeInTheDocument();
    expect(screen.queryByText('opaque-jwt-value')).not.toBeInTheDocument();
    expect(screen.queryByText('private@interviewkickstart.com')).not.toBeInTheDocument();
  });

  it('pages forward and back with bounded 50-row offsets', async () => {
    apiFns.listAdminAudit.mockImplementation((_limit: number, offset: number) =>
      Promise.resolve({
        audit: Array.from({ length: 50 }, (_, i) => ({
          ...ROW,
          id: `r-${offset}-${i}`,
        })),
      }),
    );
    renderAudit();
    await screen.findByText(/Showing the most recent 50 events/);

    // Newest page: Newer disabled, Older enabled.
    expect(screen.getByRole('button', { name: /Newer/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Older/ })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: /Older/ }));
    await waitFor(() => {
      expect(apiFns.listAdminAudit).toHaveBeenLastCalledWith(50, 50);
    });
    expect(await screen.findByText(/starting at #51/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Newer/ })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: /Newer/ }));
    await waitFor(() => {
      expect(apiFns.listAdminAudit).toHaveBeenLastCalledWith(50, 0);
    });
    expect(screen.queryByText(/starting at #51/)).not.toBeInTheDocument();
  });

  it('disables Older when the page is not full (no more records)', async () => {
    renderAudit();
    await screen.findByText(/Showing the most recent 1 events/);
    expect(screen.getByRole('button', { name: /Older/ })).toBeDisabled();
  });

  it('shows a truthful empty state', async () => {
    apiFns.listAdminAudit.mockResolvedValue({ audit: [] });
    renderAudit();
    expect(await screen.findByText('No audit events yet')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = renderAudit();
    await screen.findByText('admin_maintenance_toggle');
    await expect(container).toHaveNoViolations();
  });
});
