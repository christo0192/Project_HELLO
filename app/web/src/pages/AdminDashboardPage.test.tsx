import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdminDashboardPage } from './AdminDashboardPage';

const {
  status,
  listAdminMembers,
  updateAdminMember,
  toggleMaintenance,
  overrideSession,
  listAdminSessions,
  listAdminAudit,
  listAdminQuotas,
  createQuotaPolicy,
  updateQuotaPolicy,
} = vi.hoisted(() => ({
  status: vi.fn(),
  listAdminMembers: vi.fn(),
  updateAdminMember: vi.fn(),
  toggleMaintenance: vi.fn(),
  overrideSession: vi.fn(),
  listAdminSessions: vi.fn(),
  listAdminAudit: vi.fn(),
  listAdminQuotas: vi.fn(),
  createQuotaPolicy: vi.fn(),
  updateQuotaPolicy: vi.fn(),
}));

vi.mock('../api', () => ({
  api: {
    status,
    listAdminMembers,
    updateAdminMember,
    toggleMaintenance,
    overrideSession,
    listAdminSessions,
    listAdminAudit,
    listAdminQuotas,
    createQuotaPolicy,
    updateQuotaPolicy,
  },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

const MEMBERS = [
  { user_id: 'user-admin-0000-0000-000000000001', role: 'admin', active: true },
  { user_id: 'user-int-0000-0000-000000000002', role: 'interviewer', active: true },
];

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/admin']}>
      <AdminDashboardPage />
    </MemoryRouter>,
  );
}

describe('AdminDashboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    status.mockResolvedValue({
      status: 'ok',
      maintenance: null,
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    listAdminMembers.mockResolvedValue(MEMBERS);
    updateAdminMember.mockResolvedValue({ ok: true });
    toggleMaintenance.mockResolvedValue({ ok: true, enabled: true });
    overrideSession.mockResolvedValue({ ok: true, prior_status: 'waiting' });
    listAdminSessions.mockResolvedValue({
      sessions: [
        { id: '00000000-0000-4000-8000-000000000001', candidate_id: 'c', role_id: null, status: 'waiting', created_at: '2026-01-01T00:00:00.000Z', started_at: null, ended_at: null },
      ],
    });
    listAdminAudit.mockResolvedValue({
      audit: [
        { id: '00000000-0000-4000-8000-000000000001', action: 'admin_maintenance_toggle', actor_type: 'recruiter', actor_id: 'a', target_type: 'system', target_id: 'maintenance', result: 'success', created_at: '2026-01-01T00:00:00.000Z' },
      ],
    });
    listAdminQuotas.mockResolvedValue({
      policies: [
        { id: '00000000-0000-4000-8000-000000000002', scope: 'global', scope_id: null, mode: 'simulation', max_sessions: 10, max_cost_units: null, cost_units_per_session: 5, warning_percentage: null, period_days: 1, enabled: false, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
      ],
    });
    createQuotaPolicy.mockResolvedValue({ ok: true, id: 'p1', created: true });
    updateQuotaPolicy.mockResolvedValue({ ok: true, id: 'p1' });
  });

  it('renders service state, members, sessions, audit, and quota sections', async () => {
    renderPage();
    expect(await screen.findByText('Service state')).toBeInTheDocument();
    expect(screen.getByText('All systems operational')).toBeInTheDocument();
    expect(screen.getByText('Members')).toBeInTheDocument();
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('Override session')).toBeInTheDocument();
    expect(screen.getByText('Audit log')).toBeInTheDocument();
    expect(screen.getByText('Quota policies')).toBeInTheDocument();
  });

  it('does not claim Supabase Auth identity creation', async () => {
    renderPage();
    await screen.findByText('Service state');
    expect(screen.queryByText(/create.*user|auth.*identity|invite.*user/i)).not.toBeInTheDocument();
  });

  it('toggles maintenance with a required bounded reason', async () => {
    renderPage();
    await screen.findByText('Service state');
    await userEvent.click(screen.getByLabelText('Enable maintenance'));
    await userEvent.type(screen.getByLabelText('Reason'), 'Deployment window');
    await userEvent.click(screen.getByRole('button', { name: 'Apply maintenance toggle' }));
    await waitFor(() => {
      expect(toggleMaintenance).toHaveBeenCalledWith({
        enabled: true,
        reason: 'Deployment window',
      });
    });
    expect(await screen.findByText(/Maintenance enabled/i)).toBeInTheDocument();
  });

  it('mutates an opaque member role without email exposure', async () => {
    renderPage();
    await screen.findByText('Members');
    const roleSelects = screen.getAllByLabelText(/Role for member/i);
    await userEvent.selectOptions(roleSelects[1], 'viewer');
    const saveButtons = screen.getAllByRole('button', { name: 'Save' });
    await userEvent.click(saveButtons[1]);
    await waitFor(() => {
      expect(updateAdminMember).toHaveBeenCalledWith('user-int-0000-0000-000000000002', {
        role: 'viewer',
        active: true,
      });
    });
    expect(screen.queryByText(/@example\.com/)).not.toBeInTheDocument();
  });

  it('applies a bounded session override from the admin session list (no pre-known UUID needed)', async () => {
    renderPage();
    await screen.findByText('Override session');
    // Session is pre-selected from the list; only the reason is typed.
    await userEvent.type(screen.getByLabelText('Reason (required)'), 'Call completed off-hook');
    await userEvent.click(screen.getByRole('button', { name: 'Apply override' }));
    await waitFor(() => {
      expect(overrideSession).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', {
        target_status: 'waiting',
        reason: 'Call completed off-hook',
      });
    });
  });

  it('renders redacted audit rows', async () => {
    // A metadata/secret field on the row must never reach the DOM.
    listAdminAudit.mockResolvedValue({
      audit: [
        { id: '00000000-0000-4000-8000-000000000001', action: 'admin_maintenance_toggle', actor_type: 'recruiter', actor_id: 'a', target_type: 'system', target_id: 'maintenance', result: 'success', created_at: '2026-01-01T00:00:00.000Z', metadata: { reason: 'top-secret-reason' } },
      ],
    });
    renderPage();
    expect(await screen.findByText('admin_maintenance_toggle')).toBeInTheDocument();
    // Only bounded fields shown — no metadata value / IP / correlation claims.
    expect(screen.queryByText('top-secret-reason')).not.toBeInTheDocument();
    expect(screen.queryByText(/10\.0\.0\./)).not.toBeInTheDocument();
  });

  it('creates an abstract quota policy (units never priced)', async () => {
    renderPage();
    await screen.findByText('Create policy');
    await userEvent.type(screen.getByLabelText('Max sessions (blank = unlimited)'), '50');
    await userEvent.type(screen.getByLabelText('Max cost units (abstract)'), '1000');
    await userEvent.type(screen.getByLabelText('Cost units per session (abstract)'), '8');
    await userEvent.type(screen.getByLabelText('Warning % (blank = off)'), '80');
    await userEvent.click(screen.getByLabelText('Enabled'));
    await userEvent.click(screen.getByRole('button', { name: 'Create quota policy' }));
    await waitFor(() => {
      expect(createQuotaPolicy).toHaveBeenCalledWith({
        scope: 'global',
        scope_id: null,
        max_sessions: 50,
        max_cost_units: 1000,
        cost_units_per_session: 8,
        warning_percentage: 80,
        enabled: true,
      });
    });
    // Never any price/currency field.
    expect(createQuotaPolicy.mock.calls[0][0]).not.toHaveProperty('price');
    expect(createQuotaPolicy.mock.calls[0][0]).not.toHaveProperty('currency');
  });

  it('toggles a policy enabled state from the list', async () => {
    renderPage();
    const enableBtn = await screen.findByRole('button', { name: 'Enable' });
    await userEvent.click(enableBtn);
    await waitFor(() => {
      expect(updateQuotaPolicy).toHaveBeenCalledWith(
        '00000000-0000-4000-8000-000000000002',
        expect.objectContaining({ enabled: true }),
      );
    });
  });

  it('shows an error state when loading fails', async () => {
    status.mockRejectedValue(new Error('unauthorized'));
    listAdminMembers.mockRejectedValue(new Error('unauthorized'));
    listAdminSessions.mockRejectedValue(new Error('unauthorized'));
    listAdminAudit.mockRejectedValue(new Error('unauthorized'));
    listAdminQuotas.mockRejectedValue(new Error('unauthorized'));
    renderPage();
    expect(await screen.findByText('unauthorized')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = renderPage();
    await screen.findByText('Service state');
    await expect(container).toHaveNoViolations();
  });
});
