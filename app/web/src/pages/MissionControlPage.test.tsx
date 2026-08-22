/**
 * MissionControlPage — role-safe admin gate + section sub-navigation.
 *
 * Covers: non-admin truthful gate with ZERO admin API calls, admin renders
 * the six sections, lazy section mounting (unvisited sections never fetch),
 * keyboard subnav, dark + reduced-motion render, axe, and the Ashby Mission
 * Control navigation card.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
    // Overview (default) loads its five sources exactly once. The section's
    // fetch effect runs AFTER mount (a passive effect), so settle on the mocks
    // semantically before asserting exact counts — a bare synchronous assertion
    // races that effect. waitFor still fails a double-fetch regression, because
    // a second call would push the count to 2 and toHaveBeenCalledTimes(1)
    // would never pass (waiting until timeout).
    await waitFor(() => {
      expect(apiFns.status).toHaveBeenCalledTimes(1);
      expect(apiFns.listAdminSessions).toHaveBeenCalledTimes(1);
      expect(apiFns.listAdminAllowlist).toHaveBeenCalledTimes(1);
      expect(apiFns.listAdminQuotas).toHaveBeenCalledTimes(1);
      expect(apiFns.listAdminAudit).toHaveBeenCalledTimes(1);
    });
    // Unvisited sections do not mount, so their own loads never run.
    expect(apiFns.getMe).toHaveBeenCalledTimes(1); // page gate only

    fireEvent.click(screen.getByRole('tab', { name: 'Access' }));
    expect(await screen.findByText('Access entries')).toBeInTheDocument();
    // AccessSection mounts and performs its own read (settle its mount effect
    // before asserting the exact counts, same passive-effect reason as above).
    await waitFor(() => {
      expect(apiFns.getMe).toHaveBeenCalledTimes(2);
      expect(apiFns.listAdminAllowlist).toHaveBeenCalledTimes(2);
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Quotas' }));
    expect(await screen.findByText('Quota policies')).toBeInTheDocument();
    await waitFor(() => {
      expect(apiFns.listAdminQuotas).toHaveBeenCalledTimes(2);
    });

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

// ═══════════════════════════════════════════════════════════════════════
// Ashby Mission Control navigation card
//
// The destination route existed but nothing linked to it — the only way in
// was to type the URL. These pin the link's semantics, its exact internal
// target, and that adding it disturbed nothing else on the page.
// ═══════════════════════════════════════════════════════════════════════

describe('Ashby Mission Control navigation card', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chartStubs();
    forceLightMode();
    apiFns.getMe.mockResolvedValue(ADMIN_ME);
    apiFns.status.mockResolvedValue(OK_STATUS);
    apiFns.listAdminSessions.mockResolvedValue({ sessions: [] });
    apiFns.listAdminAllowlist.mockResolvedValue({ entries: [] });
  });
  afterEach(() => { vi.clearAllMocks(); });

  const renderAdmin = () =>
    render(
      <MemoryRouter>
        <ThemeProvider>
          <MissionControlPage />
        </ThemeProvider>
      </MemoryRouter>,
    );

  const findCard = () => screen.findByRole('link', { name: /Ashby Mission Control/i });

  it('is a visible LINK with an accessible name containing "Ashby Mission Control"', async () => {
    renderAdmin();
    expect(await findCard()).toBeVisible();
  });

  it('points at the internal route and nothing external', async () => {
    renderAdmin();
    const link = await findCard();

    // Exact internal target — a relative path, never an absolute URL.
    expect(link).toHaveAttribute('href', '/ashby-mission-control');
    const href = link.getAttribute('href') ?? '';
    expect(href.startsWith('/')).toBe(true);
    expect(href).not.toMatch(/^https?:/);
    expect(href).not.toMatch(/^\/\//);          // no protocol-relative escape
    // A plain internal link: no new tab, no opener hazard, no download.
    expect(link).not.toHaveAttribute('target');
    expect(link).not.toHaveAttribute('rel');
    expect(link).not.toHaveAttribute('download');
  });

  it('is keyboard reachable — a real anchor, focusable without a tabindex hack', async () => {
    renderAdmin();
    const link = await findCard();

    expect(link.tagName).toBe('A');
    expect(link).not.toHaveAttribute('tabindex');
    link.focus();
    expect(link).toHaveFocus();
  });

  it('adds NO network request of its own', async () => {
    renderAdmin();
    const link = await findCard();

    // Whatever the page already fetches for its own sections, the CARD adds
    // nothing: interacting with it issues no further call.
    const before = Object.values(apiFns).reduce((n, fn) => n + fn.mock.calls.length, 0);
    link.focus();
    fireEvent.mouseOver(link);
    const after = Object.values(apiFns).reduce((n, fn) => n + fn.mock.calls.length, 0);
    expect(after).toBe(before);
  });

  it('leaves every existing section tab in place', async () => {
    renderAdmin();
    await findCard();

    for (const label of ['Overview', 'Access', 'Sessions', 'Quotas', 'Audit', 'Maintenance']) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
  });

  it('is NOT shown to a non-admin, who still sees the truthful gate', async () => {
    apiFns.getMe.mockResolvedValue(VIEWER_ME);
    renderAdmin();

    expect(await screen.findByText(/Admin access required/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Ashby Mission Control/i })).toBeNull();
  });
});
