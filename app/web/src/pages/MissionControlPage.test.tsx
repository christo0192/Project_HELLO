/**
 * MissionControlPage — role-safe admin gate + section sub-navigation.
 *
 * Covers: non-admin truthful gate with ZERO admin API calls, admin renders
 * the six sections, lazy section mounting (unvisited sections never fetch),
 * keyboard subnav, dark + reduced-motion render, axe, and the header: the
 * operator halt control, which replaced the Ashby Mission Control and Phone
 * calendar quick links (both now live in the sidebar only). The control's own
 * behaviour is covered in mission-control/__tests__/OperatorHaltControl.test.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../lib/theme';
import { missionApi, apiFns } from '../components/mission-control/__tests__/apiMock';
import { chartStubs, forceDarkMode, forceLightMode } from '../components/mission-control/__tests__/renderHelpers';
import { MissionControlPage } from './MissionControlPage';

vi.mock('../api', () => ({
  api: missionApi.api,
  ApiError: missionApi.ApiError,
}));

// The halt control re-checks the role itself (defence in depth), through the
// auth context the real app provides.
const authState = vi.hoisted(() => ({ role: 'admin' as 'admin' | 'interviewer' | 'viewer' | null }));
vi.mock('../lib/auth', () => ({
  useAuth: () => ({ role: authState.role }),
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

/** `GET /api/phone/health` with the switch readable and calling live. */
const LIVE_HEALTH = {
  ok: true,
  enabled: true,
  status: 'ok' as const,
  reasons: [],
  admission: { control_present: true, halted: false, halt_reason: null },
};

const PAUSED_HEALTH = {
  ...LIVE_HEALTH,
  status: 'degraded' as const,
  reasons: ['admission_halted'],
  admission: { control_present: true, halted: true, halt_reason: 'operator_pause' },
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
    apiFns.getPhoneHealth.mockResolvedValue(LIVE_HEALTH);
    authState.role = 'admin';
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
    // Nor the operator halt: no read of the switch, no way to move it.
    expect(apiFns.getPhoneHealth).not.toHaveBeenCalled();
    expect(apiFns.setPhoneHalt).not.toHaveBeenCalled();
    expect(apiFns.clearPhoneHalt).not.toHaveBeenCalled();
    expect(screen.queryByText('Checking calling status…')).not.toBeInTheDocument();
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
    await screen.findByRole('button', { name: 'Halt all calling' });
    expect(screen.getByRole('tab', { name: 'Overview' })).toBeInTheDocument();
    await expect(container).toHaveNoViolations();
  });

  it('has no axe violations in light mode', async () => {
    const { container } = renderPage();
    await screen.findByRole('tablist', { name: 'Mission Control sections' });
    await screen.findByRole('button', { name: 'Halt all calling' });
    await expect(container).toHaveNoViolations();
  });

  it('has no axe violations with the halt confirmation open', async () => {
    const { container } = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Halt all calling' }));
    await screen.findByRole('dialog', { name: 'Halt all calling?' });
    await expect(container).toHaveNoViolations();
  });
});

function withinTablist(tablist: HTMLElement, label: string) {
  return [...tablist.querySelectorAll('[role="tab"]')].find(
    (tab) => tab.textContent === label,
  );
}

// ═══════════════════════════════════════════════════════════════════════
// The header: operator halt in, quick links out
//
// The two quick links (Ashby Mission Control, Phone calendar) were removed
// from the header; both destinations are in the sidebar's Operations group
// (Layout.test.tsx pins that). Their place on the right of the header is
// taken by the global operator halt.
// ═══════════════════════════════════════════════════════════════════════

describe('Mission Control header', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chartStubs();
    forceLightMode();
    authState.role = 'admin';
    apiFns.getMe.mockResolvedValue(ADMIN_ME);
    apiFns.status.mockResolvedValue(OK_STATUS);
    apiFns.listAdminSessions.mockResolvedValue({ sessions: [] });
    apiFns.listAdminAllowlist.mockResolvedValue({ entries: [] });
    apiFns.listAdminQuotas.mockResolvedValue({ policies: [] });
    apiFns.listAdminAudit.mockResolvedValue({ audit: [] });
    apiFns.getPhoneHealth.mockResolvedValue(LIVE_HEALTH);
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

  /** The page header block: the element holding the page's h1. */
  const header = () =>
    screen.getByRole('heading', { level: 1, name: 'Mission Control' }).closest('div')!.parentElement!;

  it('no longer renders the Ashby Mission Control or Phone calendar quick links', async () => {
    const { container } = renderAdmin();
    await screen.findByRole('button', { name: 'Halt all calling' });

    expect(screen.queryByRole('link', { name: /Ashby Mission Control/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /Phone calendar/i })).toBeNull();
    // Not merely renamed: nothing on the page points at either route.
    expect(container.querySelector('a[href="/ashby-mission-control"]')).toBeNull();
    expect(container.querySelector('a[href="/phone-calendar"]')).toBeNull();
    expect(screen.queryByText(/Ashby Mission Control/)).toBeNull();
    expect(within(header()).queryAllByRole('link')).toEqual([]);
  });

  it('renders the operator halt on the right of the page header, above the tabs', async () => {
    renderAdmin();
    const button = await screen.findByRole('button', { name: 'Halt all calling' });
    expect(header()).toContainElement(button);
    expect(within(header()).getByText('Calling: on')).toBeInTheDocument();

    const tablist = screen.getByRole('tablist', { name: 'Mission Control sections' });
    expect(button.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('reads the switch exactly once on mount and writes nothing', async () => {
    renderAdmin();
    await screen.findByRole('button', { name: 'Halt all calling' });
    await waitFor(() => expect(apiFns.getPhoneHealth).toHaveBeenCalledTimes(1));
    expect(apiFns.setPhoneHalt).not.toHaveBeenCalled();
    expect(apiFns.clearPhoneHalt).not.toHaveBeenCalled();
  });

  it('leaves every existing section tab in place', async () => {
    renderAdmin();
    await screen.findByRole('button', { name: 'Halt all calling' });
    for (const label of ['Overview', 'Access', 'Sessions', 'Quotas', 'Audit', 'Maintenance']) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
  });

  it('is NOT shown to a non-admin, who still sees the truthful gate', async () => {
    apiFns.getMe.mockResolvedValue(VIEWER_ME);
    renderAdmin();
    expect(await screen.findByText(/Admin access required/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /calling/i })).toBeNull();
    expect(apiFns.getPhoneHealth).not.toHaveBeenCalled();
  });

  it('is not rendered when the auth context disagrees with /me (defence in depth)', async () => {
    authState.role = 'interviewer';
    renderAdmin();
    await screen.findByRole('tablist', { name: 'Mission Control sections' });
    expect(screen.queryByRole('button', { name: /calling/i })).toBeNull();
    expect(screen.queryByText('Checking calling status…')).toBeNull();
    expect(apiFns.getPhoneHealth).not.toHaveBeenCalled();
  });

  it('uses only colour tokens that exist in the Tailwind theme, in both states', async () => {
    // Nothing else in this repo can catch a dead Tailwind class on this page:
    // the candidate palette guard is correctly scoped away from Mission
    // Control, Tailwind drops an unknown colour key WITHOUT erroring, neither
    // tsc nor the linter can see inside a class string, and axe cannot compute
    // colour under jsdom. So an `ink-primary` typo once shipped a focus ring
    // with no colour of its own. This resolves every colour utility on the
    // halt control — red and green states, and each open dialog — against the
    // real theme. `__dirname` + resolve, matching the repo's palette guard.
    const config = readFileSync(resolve(__dirname, '../../tailwind.config.js'), 'utf8');

    const colorsBlock = config.slice(config.indexOf('colors:'));
    const tokens = new Set<string>();
    const families = new Set<string>();
    for (const m of colorsBlock.matchAll(/^\s+'?([a-z][a-z0-9-]*)'?:\s*(['"]|\{)/gm)) {
      const key = m[1];
      if (key === 'colors') continue;
      tokens.add(key);
      families.add(key.split('-')[0]);
    }
    for (const fam of ['brand', 'accent']) {
      for (const n of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]) {
        tokens.add(`${fam}-${n}`);
      }
    }
    // Sanity: the extraction found the theme, including the token the red
    // halt button is painted with.
    expect(tokens.has('ink')).toBe(true);
    expect(tokens.has('error')).toBe(true);
    expect(tokens.has('ink-primary')).toBe(false);

    // The green resume button is painted with ARBITRARY values —
    // `bg-[var(--go)]` — which the theme lookup above cannot see and Tailwind
    // emits even when the variable does not exist (the fill is then simply
    // transparent). So every `var(--x)` a class names must be DECLARED in the
    // global token file.
    const indexCss = readFileSync(resolve(__dirname, '../index.css'), 'utf8');
    const declared = (name: string) => new RegExp(`^\\s*${name}:`, 'm').test(indexCss);
    expect(declared('--go')).toBe(true);
    expect(declared('--go-missing')).toBe(false);

    const offendersIn = (root: Element): string[] => {
      const offenders: string[] = [];
      const classNames = [root, ...Array.from(root.querySelectorAll('*'))].flatMap((el) =>
        Array.from(el.classList),
      );
      for (const cls of classNames) {
        const variable = /\[var\((--[\w-]+)\)\]/.exec(cls);
        if (variable && !declared(variable[1])) offenders.push(cls);
        const bare = cls.slice(cls.lastIndexOf(':') + 1);
        const m = /^(?:text|bg|border|ring|from|via|to|fill|stroke|divide|outline|shadow)-(.+)$/.exec(bare);
        if (!m) continue;
        const token = m[1];
        if (!families.has(token.split('-')[0])) continue;
        if (!tokens.has(token)) offenders.push(cls);
      }
      return offenders;
    };
    const control = () => document.querySelector('[data-operator-halt]')!;

    // Live: the red button, and the halt dialog.
    const { unmount } = renderAdmin();
    fireEvent.click(await screen.findByRole('button', { name: 'Halt all calling' }));
    await screen.findByRole('dialog', { name: 'Halt all calling?' });
    expect(offendersIn(control())).toEqual([]);
    unmount();

    // Paused: the green button, and the resume dialog.
    apiFns.getPhoneHealth.mockResolvedValue(PAUSED_HEALTH);
    renderAdmin();
    const resume = await screen.findByRole('button', { name: 'Resume calling' });
    // Non-vacuous: the green fill IS an arbitrary `var()` class, so the
    // declared-variable check above really runs against it.
    expect(resume).toHaveClass('bg-[var(--go)]');
    fireEvent.click(resume);
    await screen.findByRole('dialog', { name: 'Resume calling?' });
    expect(offendersIn(control())).toEqual([]);
  });
});
