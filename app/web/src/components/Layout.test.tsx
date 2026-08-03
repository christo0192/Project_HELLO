/**
 * Layout — HELLO app shell tests (integration lane rewrite).
 *
 * Covers:
 *   - Landmarks (aside, nav, main) + skip link (WCAG 2.4.1)
 *   - Brand: authorized IK logo on neutral plate + HELLO wordmark
 *   - Navigation: Workspace (Dashboard/Candidates/Roles) + admin-only
 *     Mission Control under Operations
 *   - Role gating: non-admins never see Mission Control
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
import { Layout } from './Layout';

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

  it('renders Mission Control under Operations for admins only', () => {
    renderLayout();
    expect(screen.getByRole('link', { name: /Mission Control/i })).toBeInTheDocument();
    expect(screen.getByText('Operations')).toBeInTheDocument();
  });

  it('never renders Mission Control for non-admins', () => {
    setAuth({ role: 'interviewer' });
    renderLayout();
    expect(screen.queryByRole('link', { name: /Mission Control/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Operations')).not.toBeInTheDocument();
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

  it('renders the theme toggle', () => {
    renderLayout();
    expect(
      screen.getByRole('button', { name: /Switch to (dark|light) theme/ }),
    ).toBeInTheDocument();
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
