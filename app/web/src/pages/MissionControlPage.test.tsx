/**
 * MissionControlPage — role-safe admin gate + section sub-navigation.
 *
 * Covers: non-admin truthful gate with ZERO admin API calls, admin renders
 * the six sections, lazy section mounting (unvisited sections never fetch),
 * keyboard subnav, dark + reduced-motion render, axe.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../lib/theme';
import { missionApi, apiFns } from '../components/mission-control/__tests__/apiMock';
import { chartStubs, forceDarkMode, forceLightMode } from '../components/mission-control/__tests__/renderHelpers';
import { MissionControlPage } from './MissionControlPage';

vi.mock('../api', () => ({
  api: missionApi.api,
  ApiError: missionApi.ApiError,
}));

const ADMIN_ME = {
  userId: 'u-admin',
  email: 'admin@interviewkickstart.com',
  role: 'admin' as const,
  active: true,
};

const VIEWER_ME = {
  userId: 'u-viewer',
  email: 'viewer@interviewkickstart.com',
  role: 'viewer' as const,
  active: true,
};

const OK_STATUS = {
  status: 'ok' as const,
  maintenance: { enabled: false, reason: null, updated_at: null },
  updated_at: '2026-01-01T00:00:00Z',
};

function wrap(ui: ReactNode) {
  return (
    <MemoryRouter initialEntries={['/mission-control']}>
      <ThemeProvider>{ui}</ThemeProvider>
    </MemoryRouter>
  );
}

function renderPage() {
  return render(wrap(<MissionControlPage />));
}

describe('MissionControlPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chartStubs();
    forceLightMode();
    apiFns.getMe.mockResolvedValue(ADMIN_ME);
    apiFns.status.mockResolvedValue(OK_STATUS);
    apiFns.listAdminSessions.mockResolvedValue({ sessions: [] });
    apiFns.listAdminAllowlist.mockResolvedValue({ entries: [] });
    apiFns.listAdminQuotas.mockResolvedValue({ policies: [] });
    apiFns.listAdminAudit.mockResolvedValue({ audit: [] });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows a loading state while checking access', () => {
    apiFns.getMe.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByText('Checking access…')).toBeInTheDocument();
  });

  it('shows an error state with retry when access cannot be checked', async () => {
    apiFns.getMe.mockRejectedValue(new missionApi.ApiError('unauthorized', 403));
    renderPage();
    expect(await screen.findByText('unauthorized')).toBeInTheDocument();
    apiFns.getMe.mockResolvedValue(ADMIN_ME);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByRole('tablist', { name: 'Mission Control sections' })).toBeInTheDocument();
  });

  it('gates non-admins with a truthful panel and makes ZERO admin API calls', async () => {
    apiFns.getMe.mockResolvedValue(VIEWER_ME);
    renderPage();
    expect(await screen.findByText('Admin access required')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    // No admin endpoints touched for a non-admin.
    expect(apiFns.status).not.toHaveBeenCalled();
    expect(apiFns.listAdminSessions).not.toHaveBeenCalled();
    expect(apiFns.listAdminAllowlist).not.toHaveBeenCalled();
    expect(apiFns.listAdminQuotas).not.toHaveBeenCalled();
    expect(apiFns.listAdminAudit).not.toHaveBeenCalled();
    expect(apiFns.toggleMaintenance).not.toHaveBeenCalled();
    expect(apiFns.overrideSession).not.toHaveBeenCalled();
  });

  it('renders all six Mission Control sections in the sub-navigation', async () => {
    renderPage();
    const tablist = await screen.findByRole('tablist', {
      name: 'Mission Control sections',
    });
    for (const label of ['Overview', 'Access', 'Sessions', 'Quotas', 'Audit', 'Maintenance']) {
      expect(
        withinTablist(tablist, label),
      ).toBeInTheDocument();
    }
  });

  it('mounts only Overview initially and lazily mounts sections on activation', async () => {
    renderPage();
    await screen.findByRole('tablist', { name: 'Mission Control sections' });
    // Overview (default) loads its five sources exactly once.
    expect(apiFns.status).toHaveBeenCalledTimes(1);
    expect(apiFns.listAdminSessions).toHaveBeenCalledTimes(1);
    expect(apiFns.listAdminAllowlist).toHaveBeenCalledTimes(1);
    expect(apiFns.listAdminQuotas).toHaveBeenCalledTimes(1);
    expect(apiFns.listAdminAudit).toHaveBeenCalledTimes(1);
    // Unvisited sections do not mount, so their own loads never run.
    expect(apiFns.getMe).toHaveBeenCalledTimes(1); // page gate only

    fireEvent.click(screen.getByRole('tab', { name: 'Access' }));
    expect(await screen.findByText('Access entries')).toBeInTheDocument();
    // AccessSection mounts and performs its own read.
    expect(apiFns.getMe).toHaveBeenCalledTimes(2);
    expect(apiFns.listAdminAllowlist).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('tab', { name: 'Quotas' }));
    expect(await screen.findByText('Quota policies')).toBeInTheDocument();
    expect(apiFns.listAdminQuotas).toHaveBeenCalledTimes(2);

    // Maintenance is still unmounted — its status() read never ran twice.
    expect(apiFns.status).toHaveBeenCalledTimes(1);
  });

  it('supports keyboard sub-navigation between sections', async () => {
    renderPage();
    const overview = await screen.findByRole('tab', { name: 'Overview' });
    overview.focus();
    fireEvent.keyDown(overview, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Access' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Access' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await screen.findByText('Access entries')).toBeInTheDocument();
  });

  it('renders under dark mode + reduced motion with no axe violations', async () => {
    forceDarkMode();
    const { container } = renderPage();
    await screen.findByRole('tablist', { name: 'Mission Control sections' });
    expect(screen.getByRole('tab', { name: 'Overview' })).toBeInTheDocument();
    await expect(container).toHaveNoViolations();
  });

  it('has no axe violations in light mode', async () => {
    const { container } = renderPage();
    await screen.findByRole('tablist', { name: 'Mission Control sections' });
    await expect(container).toHaveNoViolations();
  });
});

function withinTablist(tablist: HTMLElement, label: string) {
  return [...tablist.querySelectorAll('[role="tab"]')].find(
    (tab) => tab.textContent === label,
  );
}
