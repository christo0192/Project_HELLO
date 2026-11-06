/**
 * Layout — HELLO app shell tests (integration lane rewrite).
 *
 * Covers:
 *   - Landmarks (aside, nav, main) + skip link (WCAG 2.4.1)
 *   - Brand: authorized IK logo on neutral plate + HELLO wordmark
 *   - Navigation: Workspace (Dashboard/Candidates/Agents) + admin-only
 *     Ashby Live Jobs (directly above) and Mission Control under
 *     Operations
 *   - Role gating: non-admins never see either Mission Control
 *   - API health status display (online / maintenance / offline)
 *   - A calling halt: said to admins and interviewers, never read for a viewer
 *   - Auth state: user email + role chip + sign-out
 *   - Mobile drawer: toggle aria-expanded/controls, inert when closed,
 *     backdrop, Escape close + focus return, close on nav, scroll lock
 *   - axe structural compliance
 */

import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import { Link, MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Layout, pageTitleFor } from './Layout';

const mockListR1Queue = vi.hoisted(() => vi.fn());
const { getPhoneHealth } = vi.hoisted(() => ({ getPhoneHealth: vi.fn() }));

vi.mock('../api', () => ({
  api: {
    status: () =>
      Promise.resolve({ status: 'ok', maintenance: null, updated_at: '2026-01-01T00:00:00.000Z' }),
    listR1Queue: (...args: unknown[]) => mockListR1Queue(...args),
    getPhoneHealth: (...args: unknown[]) => getPhoneHealth(...args),
  },
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

type MockAuth = {
  user: { id: string; email: string } | null;
  signOut: ReturnType<typeof vi.fn>;
  isAuthenticated: boolean;
  role: 'admin' | 'interviewer' | 'viewer' | null;
};

let mockAuth: MockAuth;

vi.mock('../lib/auth', () => ({
  useAuth: () => mockAuth,
}));

function setAuth(overrides: Partial<MockAuth> = {}) {
  mockAuth = {
    user: { id: 'u1', email: 'recruiter@example.com' },
    signOut: vi.fn(),
    isAuthenticated: true,
    role: 'admin',
    ...overrides,
  };
}

function renderLayout(initialEntry = '/dashboard') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Layout />
    </MemoryRouter>,
  );
}

/** Convenience: read the inert attribute (React 19 sets `inert`). */
function sidebarInert(): boolean {
  const aside = document.getElementById('app-sidebar');
  expect(aside).not.toBeNull();
  return aside?.hasAttribute('inert') ?? false;
}

const phoneHealth = (halted: boolean, haltReason: string | null = null) => ({
  ok: true,
  enabled: true,
  status: 'ok',
  reasons: [],
  admission: { control_present: true, halted, halt_reason: haltReason },
});

beforeEach(() => {
  setAuth();
  mockListR1Queue.mockReset();
  mockListR1Queue.mockResolvedValue({ r1_deployed: false, total: 0, rounds: [] });
  getPhoneHealth.mockReset();
  getPhoneHealth.mockResolvedValue(phoneHealth(false));
});

describe('a page never outlives its URL', () => {
  /** A record page with no stale guard, which is what most routed pages are. */
  function RecordPage({ reads }: { reads: Record<string, Promise<string>> }) {
    const { id } = useParams<{ id: string }>();
    const [name, setName] = useState('Loading');
    useEffect(() => {
      void reads[id ?? ''].then(setName);
    }, [id, reads]);
    return (
      <>
        <p data-testid="record-name">{name}</p>
        <Link to="/candidates/second">Open the second record</Link>
      </>
    );
  }

  it('drops a read still in flight when the path changes under the same route', async () => {
    // One route serves every id, so without a key on the path the page stays
    // mounted: the first read then lands late and puts one person's record
    // under the other person's URL.
    let finishFirst: (name: string) => void = () => {};
    const reads = {
      first: new Promise<string>((resolve) => {
        finishFirst = resolve;
      }),
      second: Promise.resolve('Second person'),
    };
    render(
      <MemoryRouter initialEntries={['/candidates/first']}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/candidates/:id" element={<RecordPage reads={reads} />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByRole('link', { name: 'Open the second record' }));
    expect(await screen.findByText('Second person')).toBeInTheDocument();

    await act(async () => {
      finishFirst('First person');
      await reads.first;
    });
    expect(screen.getByTestId('record-name')).toHaveTextContent('Second person');
  });
});

describe('Layout shell', () => {
  it('renders landmarks and skip link', () => {
    renderLayout();
    expect(document.querySelector('aside')).toBeInTheDocument();
    expect(document.querySelector('nav[aria-label="Main navigation"]')).toBeInTheDocument();
    const main = document.querySelector('main#main-content');
    expect(main).toBeInTheDocument();
    expect(main).toHaveAttribute('tabindex', '-1');
    const skip = screen.getByRole('link', { name: 'Skip to main content' });
    expect(skip).toHaveAttribute('href', '#main-content');
  });

  it('renders the brand logo on a neutral plate with the HELLO wordmark', () => {
    renderLayout();
    const aside = document.querySelector('aside');
    expect(aside).not.toBeNull();
    const logo = aside?.querySelector('img[src="/ik-logo.png"]');
    expect(logo).toBeInTheDocument();
    // The plate is a neutral backdrop — never a CSS-invert on the image.
    expect(logo?.getAttribute('class')).not.toMatch(/invert/i);
    const { getByText } = within(aside as HTMLElement);
    expect(getByText('HELLO')).toBeInTheDocument();
    expect(getByText('Recruiting workspace')).toBeInTheDocument();
  });

  it('renders Workspace nav: Dashboard, Candidates, Agents', () => {
    renderLayout();
    expect(screen.getByRole('link', { name: /^Dashboard$/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Candidates$/ })).toBeInTheDocument();
    // Renamed from "Roles" (owner request); the route stays /roles.
    expect(screen.getByRole('link', { name: /^Agents$/ })).toHaveAttribute('href', '/roles');
    expect(screen.queryByRole('link', { name: /^Roles$/ })).toBeNull();
  });

  it('titles the top bar "Agents" on /roles', () => {
    expect(pageTitleFor('/roles')).toBe('Agents');
  });

  // Exact names throughout, so the Ashby link ("Ashby Live Jobs", formerly
  // "Ashby Mission Control") and Mission Control can never be confused.
  const MISSION_CONTROL = { name: /^Mission Control$/ };
  const ASHBY_MISSION_CONTROL = { name: /^Ashby Live Jobs$/ };

  it('renders Mission Control under Operations for admins only', () => {
    renderLayout();
    expect(screen.getByRole('link', MISSION_CONTROL)).toHaveAttribute('href', '/mission-control');
    expect(screen.getByText('Operations')).toBeInTheDocument();
  });

  it('never renders Mission Control for non-admins', () => {
    setAuth({ role: 'interviewer' });
    renderLayout();
    expect(screen.queryByRole('link', MISSION_CONTROL)).not.toBeInTheDocument();
  });

  it('renders Ashby Live Jobs under Operations for an admin, pointing at its route', () => {
    renderLayout();
    const operations = screen.getByRole('group', { name: 'Operations' });
    const link = within(operations).getByRole('link', ASHBY_MISSION_CONTROL);
    expect(link).toHaveAttribute('href', '/ashby-mission-control');
    // Same decorative-icon contract as every other nav item.
    const svg = link.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('stroke', 'currentColor');
  });

  it('orders Ashby Live Jobs directly above Mission Control', () => {
    renderLayout();
    const operations = screen.getByRole('group', { name: 'Operations' });
    const names = within(operations)
      .getAllByRole('link')
      .map((link) => link.textContent);
    expect(names).toEqual(['Ashby Live Jobs', 'Mission Control', 'Phone calendar']);
  });

  it('marks Ashby Live Jobs active on its own route, and not Mission Control', () => {
    renderLayout('/ashby-mission-control');
    expect(screen.getByRole('link', ASHBY_MISSION_CONTROL)).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', MISSION_CONTROL)).not.toHaveAttribute('aria-current');
  });

  it('titles the top bar "Ashby Live Jobs" on its route', () => {
    expect(pageTitleFor('/ashby-mission-control')).toBe('Ashby Live Jobs');
    expect(pageTitleFor('/mission-control')).toBe('Mission Control');
  });

  it('titles the top bar "R1 settings" on /admin/r1, not "HELLO"', () => {
    expect(pageTitleFor('/admin/r1')).toBe('R1 settings');
    expect(pageTitleFor('/interviews/20000000-0000-4000-8000-000000000001')).toBe('R1 review');
    // Unrelated admin-looking paths keep their own titles.
    expect(pageTitleFor('/mission-control')).toBe('Mission Control');
    expect(pageTitleFor('/admin')).toBe('HELLO');
  });

  /*
    The Operations GROUP is no longer admin-only, because the phone calendar
    inside it is readable by interviewers — that is the API's rule
    ("interviewer or above may read, admin may write"), and the nav mirrors
    it. Mission Control's and Ashby Live Jobs' own visibility is
    admin-only: both routes are `requireRole="admin"`, so offering an
    interviewer a link that redirects to /unauthorized would be worse than
    not showing it.
  */
  it('renders Operations with the phone calendar for an interviewer, and neither Mission Control', () => {
    setAuth({ role: 'interviewer' });
    renderLayout();
    expect(screen.getByText('Operations')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Phone calendar/i })).toHaveAttribute(
      'href',
      '/phone-calendar',
    );
    expect(screen.queryByRole('link', MISSION_CONTROL)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', ASHBY_MISSION_CONTROL)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Mission Control/i })).not.toBeInTheDocument();
  });

  it('renders the phone calendar alongside Mission Control for an admin', () => {
    renderLayout();
    const operations = screen.getByRole('group', { name: 'Operations' });
    expect(within(operations).getByRole('link', MISSION_CONTROL)).toBeInTheDocument();
    expect(
      within(operations).getByRole('link', { name: /Phone calendar/i }),
    ).toBeInTheDocument();
  });

  it('shows a viewer no Operations group at all', () => {
    setAuth({ role: 'viewer' });
    renderLayout();
    expect(screen.queryByText('Operations')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Phone calendar/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Mission Control/i })).not.toBeInTheDocument();
  });

  it('shows the API online status', async () => {
    renderLayout();
    expect(await screen.findByText('Online')).toBeInTheDocument();
  });

  it('shows maintenance state from /api/status', async () => {
    const apiMock = await import('../api');
    (apiMock.api as any).status = () =>
      Promise.resolve({
        status: 'maintenance',
        maintenance: { enabled: true, reason: 'window', updated_at: null },
        updated_at: '2026-01-01T00:00:00.000Z',
      });
    const { Layout: LayoutAgain } = await import('./Layout');
    render(
      <MemoryRouter initialEntries={['/candidates']}>
        <LayoutAgain />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Maintenance')).toBeInTheDocument();
    (apiMock.api as any).status = () =>
      Promise.resolve({ status: 'ok', maintenance: null, updated_at: '2026-01-01T00:00:00.000Z' });
  });

  it('shows user email, role chip, and sign-out when authenticated', () => {
    renderLayout();
    expect(screen.getByText('recruiter@example.com')).toBeInTheDocument();
    expect(screen.getByText('Admin')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  /*
    M007/S05: the top bar held a lone "Recruiter workspace" pill and, on
    desktop, a copy of the page's own <h1>. It is now a mobile-only bar that
    names the page beside the brand; desktop has the sidebar and the <h1>.
  */
  it('renders no decorative workspace pill', () => {
    renderLayout();
    expect(screen.queryByText('Recruiter workspace')).not.toBeInTheDocument();
  });

  it('keeps the top bar to small screens, naming the current page there', () => {
    renderLayout('/phone-calendar');
    const bar = document.querySelector('header');
    expect(bar).not.toBeNull();
    expect(bar?.className).toMatch(/(^|\s)lg:hidden(\s|$)/);
    expect(within(bar as HTMLElement).getByRole('button', { name: 'Open navigation menu' })).toBeInTheDocument();
    // The visible name is a duplicate of the announcer below, so it is
    // hidden from assistive technology rather than read twice.
    const visible = within(bar as HTMLElement).getByText('Phone calendar');
    expect(visible).toHaveAttribute('aria-hidden', 'true');
  });

  it('announces the page name politely at every width, and on navigation', async () => {
    const user = userEvent.setup();
    renderLayout('/dashboard');
    const announcer = document.querySelector('[aria-live="polite"]');
    expect(announcer).not.toBeNull();
    expect(announcer?.className).toContain('sr-only');
    // Not inside the mobile-only bar, so desktop keeps its announcements.
    expect(announcer?.closest('header')).toBeNull();
    expect(announcer?.textContent).toBe('Dashboard');

    await user.click(screen.getByRole('button', { name: 'Open navigation menu' }));
    await user.click(screen.getByRole('link', { name: /^Agents$/ }));
    await waitFor(() => expect(announcer?.textContent).toBe('Agents'));
  });
});

describe('the R1 interviews item', () => {
  const answered = (r1_deployed: boolean, total: number) =>
    mockListR1Queue.mockResolvedValue({ r1_deployed, total, rounds: [] });

  it('sits in Workspace, between Candidates and Agents, on a server that runs R1', async () => {
    answered(true, 0);
    renderLayout();
    const link = await screen.findByRole('link', { name: 'R1 interviews' });
    expect(link).toHaveAttribute('href', '/interviews');
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(within(nav).getAllByRole('link').map((item) => item.textContent).slice(0, 4)).toEqual([
      'Dashboard', 'Candidates', 'R1 interviews', 'Agents',
    ]);
  });

  it('stays for rounds that already exist, on a server that no longer runs R1', async () => {
    answered(false, 3);
    renderLayout();
    expect(await screen.findByRole('link', { name: 'R1 interviews' })).toBeInTheDocument();
  });

  it('is hidden when R1 is not deployed and no round exists, and asks with dry runs counted', async () => {
    answered(false, 0);
    renderLayout();
    await waitFor(() => expect(mockListR1Queue).toHaveBeenCalledWith({ view: 'all', pageSize: 1, includeDryRuns: true }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('link', { name: 'R1 interviews' })).toBeNull();
  });

  it('never flashes in before the answer', async () => {
    mockListR1Queue.mockReturnValue(new Promise(() => undefined));
    renderLayout();
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('link', { name: 'R1 interviews' })).toBeNull();
  });

  it('shows when the read fails: not knowing is no reason to take the way there away', async () => {
    mockListR1Queue.mockRejectedValue(new Error('service_unavailable'));
    renderLayout();
    expect(await screen.findByRole('link', { name: 'R1 interviews' })).toBeInTheDocument();
  });

  it.each(['admin', 'interviewer', 'viewer'] as const)('shows for %s: everyone who can read rounds', async (role) => {
    setAuth({ role });
    answered(true, 0);
    renderLayout();
    expect(await screen.findByRole('link', { name: 'R1 interviews' })).toBeInTheDocument();
  });

  it('stays marked on the review page, and asks once for the whole session', async () => {
    answered(true, 1);
    renderLayout('/interviews/round-1');
    const link = await screen.findByRole('link', { name: 'R1 interviews' });
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(mockListR1Queue).toHaveBeenCalledTimes(1);
  });

  it('names the queue and the review page apart', () => {
    expect(pageTitleFor('/interviews')).toBe('R1 interviews');
    expect(pageTitleFor('/interviews/round-1')).toBe('R1 review');
  });
});

describe('Layout: the tab title', () => {
  it.each([
    ['/candidates', 'Candidates · HELLO'],
    ['/candidates/some-id', 'Candidate · HELLO'],
    ['/roles', 'Agents · HELLO'],
    ['/mission-control', 'Mission Control · HELLO'],
    ['/ashby-mission-control', 'Ashby Live Jobs · HELLO'],
  ])('names %s, and never a person', async (path, title) => {
    renderLayout(path);
    await waitFor(() => expect(document.title).toBe(title));
  });
});

describe('Layout: the desk and the sheet', () => {
  it('lays the page on one opaque sheet, inset 8px from the window', () => {
    renderLayout();
    const main = document.querySelector('main#main-content');
    expect(main).toHaveClass('sheet', 'm-2');
  });

  it('sets a 232px sidebar on the desk that stays on screen at any scroll', () => {
    renderLayout();
    const aside = document.getElementById('app-sidebar');
    expect(aside).toHaveClass('w-[232px]', 'bg-surface-tertiary', 'lg:sticky', 'lg:top-0', 'lg:h-screen');
  });

  it('keeps the drawer motion to the slide-over duration, with no overshoot', () => {
    renderLayout();
    const aside = document.getElementById('app-sidebar');
    expect(aside?.className).toContain('duration-[220ms]');
    expect(aside?.className).not.toMatch(/cubic-bezier/);
  });

  it('names the sign-out control though it is an icon', () => {
    renderLayout();
    expect(screen.getByRole('button', { name: 'Sign out' }).querySelector('svg')).toBeInTheDocument();
  });

});

describe('Layout: a calling halt', () => {
  const PAUSED = 'Calling halted — operator pause';

  /** Answers the read, then moves the clock past the shortest gap between two. */
  async function afterTheGap(reads: number) {
    await waitFor(() => expect(getPhoneHealth).toHaveBeenCalledTimes(reads));
    const later = Date.now() + 16_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
  }

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, 'matchMedia');
  });

  it.each(['admin', 'interviewer'] as const)('tells %s, whichever page they are on', async (role) => {
    setAuth({ role });
    getPhoneHealth.mockResolvedValue(phoneHealth(true, 'operator_pause'));
    renderLayout('/phone-calendar');
    expect(await screen.findByText(PAUSED)).toHaveAttribute('role', 'status');
  });

  it('names a halt nobody here can lift, in the same line', async () => {
    getPhoneHealth.mockResolvedValue(phoneHealth(true, 'legal_hold'));
    renderLayout();
    expect(await screen.findByText('Calling halted — legal hold')).toBeInTheDocument();
  });

  it('offers no Halt or Resume button, which stay in Mission Control', async () => {
    getPhoneHealth.mockResolvedValue(phoneHealth(true, 'operator_pause'));
    renderLayout();
    await screen.findByText(PAUSED);
    expect(screen.queryByRole('button', { name: /halt|resume/i })).not.toBeInTheDocument();
  });

  it('asks nothing for a viewer, because the read would answer 403 on every route', async () => {
    setAuth({ role: 'viewer' });
    getPhoneHealth.mockResolvedValue(phoneHealth(true, 'operator_pause'));
    renderLayout();
    expect(await screen.findByText('Online')).toBeInTheDocument();
    expect(getPhoneHealth).not.toHaveBeenCalled();
    expect(screen.queryByText(/calling/i)).not.toBeInTheDocument();
  });

  it('says nothing while calling is on', async () => {
    renderLayout();
    await waitFor(() => expect(getPhoneHealth).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Online')).toBeInTheDocument();
    expect(screen.queryByText(/calling/i)).not.toBeInTheDocument();
  });

  it.each([
    ['a failed read', () => getPhoneHealth.mockRejectedValue(new Error('nope'))],
    ['screening turned off', () => getPhoneHealth.mockResolvedValue({ ok: true, enabled: false, status: 'disabled', reasons: [], admission: null })],
    ['a missing control row', () => getPhoneHealth.mockResolvedValue({ ...phoneHealth(true), admission: { control_present: false, halted: true, halt_reason: null } })],
  ])('claims no halt from %s', async (_label, arrange) => {
    arrange();
    renderLayout();
    await waitFor(() => expect(getPhoneHealth).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Online')).toBeInTheDocument();
    expect(screen.queryByText(/calling/i)).not.toBeInTheDocument();
  });

  it('takes the line down when the halt is lifted and the tab comes back', async () => {
    getPhoneHealth.mockResolvedValue(phoneHealth(true, 'operator_pause'));
    renderLayout();
    await screen.findByText(PAUSED);
    await afterTheGap(1);
    getPhoneHealth.mockResolvedValue(phoneHealth(false));
    fireEvent.focus(window);
    await waitFor(() => expect(screen.queryByText(PAUSED)).not.toBeInTheDocument());
    expect(getPhoneHealth).toHaveBeenCalledTimes(2);
  });

  it('keeps the line through a re-read that fails: that says nothing about the switch', async () => {
    getPhoneHealth.mockResolvedValue(phoneHealth(true, 'operator_pause'));
    renderLayout();
    await screen.findByText(PAUSED);
    await afterTheGap(1);
    getPhoneHealth.mockRejectedValue(new Error('nope'));
    fireEvent.focus(window);
    await waitFor(() => expect(getPhoneHealth).toHaveBeenCalledTimes(2));
    expect(screen.getByText(PAUSED)).toBeInTheDocument();
  });

  it('reads again on a route change, but not on every one', async () => {
    const user = userEvent.setup();
    renderLayout('/dashboard');
    await waitFor(() => expect(getPhoneHealth).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('link', { name: /^Candidates$/ }));
    await waitFor(() => expect(document.title).toBe('Candidates · HELLO'));
    expect(getPhoneHealth).toHaveBeenCalledTimes(1);

    await afterTheGap(1);
    getPhoneHealth.mockResolvedValue(phoneHealth(true, 'emergency_stop'));
    await user.click(screen.getByRole('link', { name: /^Agents$/ }));
    expect(await screen.findByText('Calling halted — emergency stop')).toBeInTheDocument();
    expect(getPhoneHealth).toHaveBeenCalledTimes(2);
  });

  it('sits in the sidebar at a desk, where it stays on screen', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }),
    });
    getPhoneHealth.mockResolvedValue(phoneHealth(true, 'operator_pause'));
    renderLayout();
    expect((await screen.findAllByText(PAUSED))).toHaveLength(1);
    expect(document.getElementById('app-sidebar')).toContainElement(screen.getByText(PAUSED));
  });

  it('sits under the top bar on a narrow screen, where the sidebar is folded away', async () => {
    getPhoneHealth.mockResolvedValue(phoneHealth(true, 'operator_pause'));
    renderLayout();
    expect((await screen.findAllByText(PAUSED))).toHaveLength(1);
    expect(document.getElementById('app-sidebar')).not.toContainElement(screen.getByText(PAUSED));
  });

  it('has no axe violations with the line up', async () => {
    getPhoneHealth.mockResolvedValue(phoneHealth(true, 'operator_pause'));
    const { container } = renderLayout();
    await screen.findByText(PAUSED);
    await expect(container).toHaveNoViolations();
  });
});

describe('Layout mobile drawer', () => {
  it('is inert (out of tab order/a11y tree) while closed', () => {
    renderLayout();
    expect(sidebarInert()).toBe(true);
  });

  it('opens via the menu toggle and reflects state with aria-expanded', async () => {
    const user = userEvent.setup();
    renderLayout();
    const toggle = screen.getByRole('button', { name: 'Open navigation menu' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', 'app-sidebar');
    await user.click(toggle);
    // Toggle now reads "Close navigation menu" (multiple close affordances
    // exist: toggle, sidebar ✕, backdrop).
    expect(
      screen.getAllByRole('button', { name: 'Close navigation menu' }).length,
    ).toBeGreaterThanOrEqual(1);
    expect(sidebarInert()).toBe(false);
    // Focus moves into the drawer (first nav link).
    await waitFor(() => {
      expect(screen.getByRole('link', { name: /^Dashboard$/ })).toHaveFocus();
    });
  });

  it('closes on backdrop click and returns focus to the toggle', async () => {
    const user = userEvent.setup();
    renderLayout();
    const toggle = screen.getByRole('button', { name: 'Open navigation menu' });
    await user.click(toggle);
    // The backdrop is a full-screen close button.
    const backdrop = screen.getAllByRole('button', { name: 'Close navigation menu' })[0];
    fireEvent.click(backdrop);
    expect(sidebarInert()).toBe(true);
    await waitFor(() => expect(toggle).toHaveFocus());
  });

  it('closes on Escape and returns focus to the toggle', async () => {
    const user = userEvent.setup();
    renderLayout();
    const toggle = screen.getByRole('button', { name: 'Open navigation menu' });
    await user.click(toggle);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(sidebarInert()).toBe(true);
    await waitFor(() => expect(toggle).toHaveFocus());
  });

  it('locks body scroll while the drawer is open and restores it after', async () => {
    const user = userEvent.setup();
    renderLayout();
    await user.click(screen.getByRole('button', { name: 'Open navigation menu' }));
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(document.body.style.overflow).toBe(''));
  });

  it('closes the drawer when a nav link is activated', async () => {
    const user = userEvent.setup();
    renderLayout();
    await user.click(screen.getByRole('button', { name: 'Open navigation menu' }));
    expect(sidebarInert()).toBe(false);
    // Clicking a nav link closes the drawer (and navigates).
    await user.click(screen.getByRole('link', { name: /^Candidates$/ }));
    await waitFor(() => expect(sidebarInert()).toBe(true));
  });

  it('is not inert when the drawer is open', async () => {
    const user = userEvent.setup();
    renderLayout();
    await user.click(screen.getByRole('button', { name: 'Open navigation menu' }));
    expect(sidebarInert()).toBe(false);
  });
});

describe('Layout a11y + reduced motion', () => {
  it('has no axe violations', async () => {
    const { container } = renderLayout();
    await expect(container).toHaveNoViolations();
  });

  it('has no axe violations with the drawer open', async () => {
    const user = userEvent.setup();
    const { container } = renderLayout();
    await user.click(screen.getByRole('button', { name: 'Open navigation menu' }));
    await expect(container).toHaveNoViolations();
  });
});
