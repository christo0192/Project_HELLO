/**
 * OverviewSection — truthful ops KPIs/charts.
 * Covers: KPIs derived from real data, maintenance state, charts with
 * sr-only data tables, the not-available panel (no fabricated health/SLO/
 * deployment/queue/cost claims), no emails on this surface, per-source
 * errors with retry, dark + reduced-motion render, axe.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { missionApi, apiFns } from './apiMock';
import { OverviewSection } from '../OverviewSection';
import { wrapTheme, chartStubs, forceDarkMode, forceLightMode } from './renderHelpers';

vi.mock('../../../api', () => ({
  api: missionApi.api,
  ApiError: missionApi.ApiError,
}));

const STATUS = {
  status: 'ok' as const,
  maintenance: { enabled: false, reason: null, updated_at: null },
  updated_at: '2026-01-10T12:00:00Z',
};

const SESSIONS = [
  { id: 's1', candidate_id: 'c1', role_id: null, status: 'completed' as const, created_at: '2026-01-10T10:00:00Z', started_at: null, ended_at: null },
  { id: 's2', candidate_id: 'c2', role_id: null, status: 'in_progress' as const, created_at: '2026-01-10T11:00:00Z', started_at: null, ended_at: null },
  { id: 's3', candidate_id: 'c3', role_id: null, status: 'failed' as const, created_at: '2026-01-09T11:00:00Z', started_at: null, ended_at: null },
];

const ENTRIES = [
  { id: 'e1', email: 'a@interviewkickstart.com', role: 'admin' as const, active: true, linked_user_id: 'u1', linked_at: '2026-01-01T00:00:00Z' },
  { id: 'e2', email: 'b@interviewkickstart.com', role: 'viewer' as const, active: true, linked_user_id: null, linked_at: null },
  { id: 'e3', email: 'c@interviewkickstart.com', role: 'viewer' as const, active: false, linked_user_id: 'u3', linked_at: '2026-01-01T00:00:00Z' },
];

const POLICIES = [
  { id: 'p1', scope: 'global' as const, scope_id: null, mode: 'simulation' as const, max_sessions: 10, max_cost_units: null, cost_units_per_session: 5, warning_percentage: null, period_days: 1, enabled: true, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
  { id: 'p2', scope: 'candidate' as const, scope_id: 'c-x', mode: 'live' as const, max_sessions: 3, max_cost_units: 100, cost_units_per_session: 8, warning_percentage: 80, period_days: 7, enabled: false, created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' },
];

// Relative timestamps so the 24h audit-window KPI is deterministic.
const NOW = Date.now();
const HOUR = 3_600_000;

const AUDIT = [
  { id: 'a1', action: 'admin_maintenance_toggle', actor_type: 'recruiter', actor_id: 'x', target_type: 'system', target_id: 'y', result: 'success', created_at: new Date(NOW - HOUR).toISOString() },
  { id: 'a2', action: 'allowlist_add', actor_type: 'recruiter', actor_id: 'x', target_type: 'allowlist', target_id: 'y', result: 'success', created_at: new Date(NOW - 2 * HOUR).toISOString() },
  { id: 'a3', action: 'old_event', actor_type: 'recruiter', actor_id: 'x', target_type: 'system', target_id: 'y', result: 'success', created_at: new Date(NOW - 30 * 24 * HOUR).toISOString() },
];

function renderOverview() {
  return render(wrapTheme(<OverviewSection />));
}

describe('OverviewSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chartStubs();
    forceLightMode();
    apiFns.status.mockResolvedValue(STATUS);
    apiFns.listAdminSessions.mockResolvedValue({ sessions: SESSIONS });
    apiFns.listAdminAllowlist.mockResolvedValue({ entries: ENTRIES });
    apiFns.listAdminQuotas.mockResolvedValue({ policies: POLICIES });
    apiFns.listAdminAudit.mockResolvedValue({ audit: AUDIT });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('derives every KPI from the returned data', async () => {
    renderOverview();
    await screen.findByText('Service state');

    const sessionsCard = screen
      .getAllByText('Sessions')
      .find((el) => el.tagName === 'P')!
      .closest('.shadow-card') as HTMLElement;
    await waitFor(() => {
      expect(within(sessionsCard).getByText('3')).toBeInTheDocument();
    });

    const activeCard = screen.getByText('Active sessions').closest('.shadow-card') as HTMLElement;
    expect(within(activeCard).getByText('1')).toBeInTheDocument();

    const linkedCard = screen.getByText('Linked access').closest('.shadow-card') as HTMLElement;
    expect(within(linkedCard).getByText('1')).toBeInTheDocument();

    const quotaCard = screen.getByText('Quota policies enabled').closest('.shadow-card') as HTMLElement;
    expect(within(quotaCard).getByText('1')).toBeInTheDocument();

    // Audit: 2 events in the last 24h within the 50-row page (a3 is old).
    const auditCard = screen.getByText('Audit events · 24h').closest('.shadow-card') as HTMLElement;
    expect(within(auditCard).getByText('2')).toBeInTheDocument();
    expect(within(auditCard).getByText('within the 50 most recent events')).toBeInTheDocument();
  });

  it('renders the maintenance state from /api/status', async () => {
    renderOverview();
    await screen.findByText('Service state');
    expect(screen.getByText('Operational')).toBeInTheDocument();
    expect(screen.getByText('No maintenance window is active.')).toBeInTheDocument();
  });

  it('renders charts with sr-only data tables as the authoritative data', async () => {
    renderOverview();
    await screen.findByText('Session status mix');
    const statusTable = await screen.findByRole('table', { name: 'Session status data' });
    expect(within(statusTable).getByRole('cell', { name: 'Completed' })).toBeInTheDocument();
    expect(within(statusTable).getByRole('cell', { name: 'In progress' })).toBeInTheDocument();

    const activityTable = await screen.findByRole('table', { name: 'Sessions created per day data' });
    expect(within(activityTable).getAllByRole('row').length).toBeGreaterThan(1);
  });

  it('shows the not-available panel instead of fabricating health/SLO/deploy/queue/cost claims', async () => {
    renderOverview();
    await screen.findByText('Operational areas without source data');
    expect(screen.getByText('Provider health')).toBeInTheDocument();
    expect(screen.getByText('Uptime / SLO')).toBeInTheDocument();
    expect(screen.getByText('Deployment status')).toBeInTheDocument();
    expect(screen.getByText('Queue depth')).toBeInTheDocument();
    expect(screen.getByText('Cost')).toBeInTheDocument();
    // No invented numbers: no % uptime, no SLO, no $ amounts anywhere.
    expect(screen.queryByText(/% uptime|99\.\d+%/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/deploying|rolling out/i)).not.toBeInTheDocument();
  });

  it('never renders email addresses on the overview surface', async () => {
    renderOverview();
    await screen.findByText('Access entries');
    expect(screen.queryByText(/@interviewkickstart\.com/)).not.toBeInTheDocument();
    // The summary shows counts only.
    expect(screen.getAllByText('Linked').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Pending').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Disabled').length).toBeGreaterThan(0);
  });

  it('shows per-source errors with retry instead of fabricated numbers', async () => {
    apiFns.listAdminSessions.mockRejectedValue(new missionApi.ApiError('sessions down', 500));
    apiFns.listAdminQuotas.mockRejectedValue(new missionApi.ApiError('quotas down', 500));
    renderOverview();
    await screen.findByText('Session status mix');
    expect(await screen.findByText(/Session status mix — sessions down/)).toBeInTheDocument();
    expect(await screen.findByText(/Quota policy state — quotas down/)).toBeInTheDocument();
    // KPI values for failed sources are never claimed — zero-filled 0 is
    // scoped to the Sessions card (not a fabricated total).
    const sessionsCard = screen.getByText('Sessions').closest('.shadow-card') as HTMLElement;
    expect(within(sessionsCard).getByText('0')).toBeInTheDocument();
  });

  it('recovers via the per-source retry', async () => {
    apiFns.listAdminSessions.mockRejectedValueOnce(new missionApi.ApiError('sessions down', 500));
    renderOverview();
    await screen.findByText(/Session status mix — sessions down/);
    const retry = screen.getAllByRole('button', { name: /try again/i })[0];
    fireEvent.click(retry);
    expect(await screen.findByText('Session status mix')).toBeInTheDocument();
    await waitFor(() => {
      expect(apiFns.listAdminSessions).toHaveBeenCalledTimes(2);
    });
  });

  it('renders under dark mode + reduced motion', async () => {
    forceDarkMode();
    const { container } = renderOverview();
    await screen.findByText('Service state');
    expect(screen.getByText('Operational')).toBeInTheDocument();
    await expect(container).toHaveNoViolations();
  });

  it('has no axe violations in light mode', async () => {
    const { container } = renderOverview();
    await screen.findByText('Service state');
    await expect(container).toHaveNoViolations();
  });
});
