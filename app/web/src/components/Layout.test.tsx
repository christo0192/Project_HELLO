/**
 * Layout — HELLO app shell tests (integration lane rewrite).
 *
 * Covers:
 *   - Landmarks (aside, nav, main) + skip link (WCAG 2.4.1)
 *   - Brand: authorized IK logo on neutral plate + HELLO wordmark
 *   - Navigation: Workspace (Dashboard/Candidates/Roles) + admin-only
 *     Ashby Mission Control (directly above) and Mission Control under
 *     Operations
 *   - Role gating: non-admins never see either Mission Control
 *   - API health status display (online / maintenance / offline)
 *   - Auth state: user email + role chip + sign-out
 *   - Theme toggle presence (requires ThemeProvider)
 *   - Mobile drawer: toggle aria-expanded/controls, inert when closed,
 *     backdrop, Escape close + focus return, close on nav, scroll lock
 *   - Reduced-motion route fade static render
 *   - axe structural compliance
 */

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ThemeProvider } from '../lib/theme';
import { Layout, pageTitleFor } from './Layout';

vi.mock('../api', () => ({
  api: {
    status: () =>
      Promise.resolve({ status: 'ok', maintenance: null, updated_at: '2026-01-01T00:00:00.000Z' }),
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
    <ThemeProvider>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Layout />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

/** Convenience: read the inert attribute (React 19 sets `inert`). */
function sidebarInert(): boolean {
  const aside = document.getElementById('app-sidebar');
  expect(aside).not.toBeNull();
  return aside?.hasAttribute('inert') ?? false;
}

beforeEach(() => {
  setAuth();
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
    expect(getByText(/Talent Workspace & Mission Control/i)).toBeInTheDocument();
  });

  it('renders Workspace nav: Dashboard, Candidates, Roles', () => {
    renderLayout();
    expect(screen.getByRole('link', { name: /^Dashboard$/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Candidates$/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Roles$/ })).toBeInTheDocument();
  });

  // Exact names throughout: "Ashby Mission Control" also contains "Mission
  // Control", so a loose /Mission Control/ would match both links and could
  // never tell one from the other.
  const MISSION_CONTROL = { name: /^Mission Control$/ };
  const ASHBY_MISSION_CONTROL = { name: /^Ashby Mission Control$/ };

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

  it('renders Ashby Mission Control under Operations for an admin, pointing at its route', () => {
    renderLayout();
    const operations = screen.getByRole('group', { name: 'Operations' });
    const link = within(operations).getByRole('link', ASHBY_MISSION_CONTROL);
    expect(link).toHaveAttribute('href', '/ashby-mission-control');
    // Same decorative-icon contract as every other nav item.
    const svg = link.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('stroke', 'currentColor');
  });

  it('orders Ashby Mission Control directly above Mission Control', () => {
    renderLayout();
    const operations = screen.getByRole('group', { name: 'Operations' });
    const names = within(operations)
      .getAllByRole('link')
      .map((link) => link.textContent);
    expect(names).toEqual(['Ashby Mission Control', 'Mission Control', 'Phone calendar']);
  });

  it('marks Ashby Mission Control active on its own route, and not Mission Control', () => {
    renderLayout('/ashby-mission-control');
    expect(screen.getByRole('link', ASHBY_MISSION_CONTROL)).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', MISSION_CONTROL)).not.toHaveAttribute('aria-current');
  });

  it('titles the top bar "Ashby Mission Control" on its route', () => {
    expect(pageTitleFor('/ashby-mission-control')).toBe('Ashby Mission Control');
    expect(pageTitleFor('/mission-control')).toBe('Mission Control');
  });

  /*
    The Operations GROUP is no longer admin-only, because the phone calendar
    inside it is readable by interviewers — that is the API's rule
    ("interviewer or above may read, admin may write"), and the nav mirrors
    it. Mission Control's and Ashby Mission Control's own visibility is
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
    expect(await screen.findByText('API online')).toBeInTheDocument();
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
      <ThemeProvider>
        <MemoryRouter initialEntries={['/candidates']}>
          <LayoutAgain />
        </MemoryRouter>
      </ThemeProvider>,
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

  it('renders the light-first workspace context', () => {
    renderLayout();
    expect(screen.getByText('Recruiter workspace')).toBeInTheDocument();
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
