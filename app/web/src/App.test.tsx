/**
 * App — route wiring integration tests (integration lane).
 *
 * Verifies the premium coherent routing contract deterministically:
 *   - `/` lands on `/dashboard` (primary TA/HR landing)
 *   - `/dashboard`, `/candidates/:id`, `/sessions/:id` render their pages
 *   - `/admin` is a safe alias redirecting to `/mission-control`
 *   - Mission Control is admin-gated (non-admin → /unauthorized)
 *   - all legacy public routes still render (login)
 *   - unknown paths: authenticated → dashboard; unauthenticated → 404
 *   - lazy chunks resolve (React.lazy + Suspense) inside the app shell
 *
 * Heavy pages are module-mocked (route-target assertion, not page logic);
 * page logic has its own suites. Charts require ThemeProvider, which the
 * real main.tsx mounts — mirrored here.
 */

import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { ThemeProvider } from './lib/theme';
import App from './App';

// ── Mocks ──────────────────────────────────────────────────────────────

type MockAuth = {
  isLoading: boolean;
  isAuthenticated: boolean;
  needsMfa: boolean;
  factors: Array<{ id: string; type: 'totp' }>;
  role: 'admin' | 'interviewer' | 'viewer' | null;
};

let mockAuth: MockAuth;

vi.mock('./lib/auth', () => ({
  useAuth: () => mockAuth,
  ALLOWED_EMAIL_DOMAIN: 'interviewkickstart.com',
  isCompanyEmail: () => false,
  getSsoProviders: () => [],
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('./api', () => ({
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

// Route-target assertions only — page internals are covered by their own
// suites; these mocks keep ECharts/motion-heavy pages out of route tests.
vi.mock('./pages/DashboardPage', () => ({
  DashboardPage: () => <div data-testid="page-dashboard">Dashboard</div>,
}));
vi.mock('./pages/CandidateDetailPage', () => ({
  CandidateDetailPage: () => <div data-testid="page-candidate-detail">Candidate detail</div>,
}));
vi.mock('./pages/SessionDetailPage', () => ({
  SessionDetailPage: () => <div data-testid="page-session-detail">Session detail</div>,
}));
vi.mock('./pages/MissionControlPage', () => ({
  MissionControlPage: () => <div data-testid="page-mission-control">Mission Control</div>,
}));
vi.mock('./pages/PhoneCalendarPage', () => ({
  PhoneCalendarPage: () => <div data-testid="page-phone-calendar">Phone calendar</div>,
}));

function renderApp(initialEntry = '/dashboard') {
  // App owns its <BrowserRouter>; drive the URL through the history API.
  window.history.pushState({}, '', initialEntry);
  return render(
    <ThemeProvider>
      <App />
    </ThemeProvider>,
  );
}

function authedAdmin() {
  mockAuth = {
    isLoading: false,
    isAuthenticated: true,
    needsMfa: false,
    factors: [],
    role: 'admin',
  };
}

function authedInterviewer() {
  mockAuth = {
    isLoading: false,
    isAuthenticated: true,
    needsMfa: false,
    factors: [],
    role: 'interviewer',
  };
}

function authedViewer() {
  mockAuth = {
    isLoading: false,
    isAuthenticated: true,
    needsMfa: false,
    factors: [],
    role: 'viewer',
  };
}

function unauthenticated() {
  mockAuth = {
    isLoading: false,
    isAuthenticated: false,
    needsMfa: false,
    factors: [],
    role: null,
  };
}

beforeEach(() => {
  authedAdmin();
});

describe('App route wiring', () => {
  it('redirects / to the dashboard landing', async () => {
    renderApp('/');
    // First test in the file pays the cold lazy-chunk import; under host
    // load that can exceed the 1s default.
    expect(await screen.findByTestId('page-dashboard', {}, { timeout: 5000 })).toBeInTheDocument();
  });

  it('renders the dashboard at /dashboard', async () => {
    renderApp('/dashboard');
    expect(await screen.findByTestId('page-dashboard')).toBeInTheDocument();
  });

  it('renders candidate detail at /candidates/:id', async () => {
    renderApp('/candidates/c-123');
    expect(await screen.findByTestId('page-candidate-detail')).toBeInTheDocument();
  });

  it('renders session detail at /sessions/:id', async () => {
    renderApp('/sessions/s-456');
    expect(await screen.findByTestId('page-session-detail')).toBeInTheDocument();
  });

  it('renders Mission Control for admins at /mission-control', async () => {
    renderApp('/mission-control');
    expect(await screen.findByTestId('page-mission-control')).toBeInTheDocument();
  });

  it('aliases /admin to /mission-control for admins', async () => {
    renderApp('/admin');
    expect(await screen.findByTestId('page-mission-control')).toBeInTheDocument();
  });

  it('gates Mission Control for non-admins (→ /unauthorized)', async () => {
    authedInterviewer();
    renderApp('/mission-control');
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
  });

  /*
    The phone calendar is authenticated but NOT role-gated at the route.
    `ProtectedRoute`'s gate is exact equality, so `requireRole="admin"` would
    lock out the interviewers the API is happy to serve, and there is no
    "interviewer or above" gate to use instead. All three authenticated roles
    therefore REACH the route, and the page itself tells them apart — which is
    what lets a viewer be shown a truthful panel instead of a redirect, with
    no phone request made. `PhoneCalendarPage.test.tsx` covers that gating.
  */
  it('renders the phone calendar at /phone-calendar for an admin', async () => {
    renderApp('/phone-calendar');
    expect(await screen.findByTestId('page-phone-calendar')).toBeInTheDocument();
  });

  it('renders the phone calendar at /phone-calendar for an interviewer', async () => {
    authedInterviewer();
    renderApp('/phone-calendar');
    expect(await screen.findByTestId('page-phone-calendar')).toBeInTheDocument();
  });

  it('lets a viewer reach the route so the PAGE can gate them, not a redirect', async () => {
    authedViewer();
    renderApp('/phone-calendar');
    expect(await screen.findByTestId('page-phone-calendar')).toBeInTheDocument();
  });

  it('sends an unauthenticated visitor to /login, like every protected route', async () => {
    unauthenticated();
    renderApp('/phone-calendar');
    expect(await screen.findByText(/Recruiter sign-in/i)).toBeInTheDocument();
    expect(screen.queryByTestId('page-phone-calendar')).not.toBeInTheDocument();
  });

  it('renders the phone calendar inside the app shell, with the nav', async () => {
    renderApp('/phone-calendar');
    await screen.findByTestId('page-phone-calendar');
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
  });

  it('redirects unknown protected paths to /dashboard when authenticated', async () => {
    renderApp('/does-not-exist');
    expect(await screen.findByTestId('page-dashboard')).toBeInTheDocument();
  });

  it('renders a truthful 404 for unknown paths when unauthenticated', async () => {
    unauthenticated();
    renderApp('/does-not-exist');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to sign-in' })).toBeInTheDocument();
  });

  it('redirects protected pages to /login when unauthenticated', async () => {
    unauthenticated();
    renderApp('/dashboard');
    expect(await screen.findByText(/Recruiter sign-in/i)).toBeInTheDocument();
  });

  it('renders the legacy login page at /login', async () => {
    unauthenticated();
    renderApp('/login');
    expect(await screen.findByText(/Recruiter sign-in/i)).toBeInTheDocument();
  });

  it('renders the app shell (aside, main, skip link) around routed pages', async () => {
    renderApp('/dashboard');
    await screen.findByTestId('page-dashboard');
    expect(document.querySelector('aside#app-sidebar')).toBeInTheDocument();
    expect(document.querySelector('main#main-content')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Skip to main content' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Candidates$/ })).toBeInTheDocument();
  });

  it('has no axe violations on the dashboard shell', async () => {
    const { container } = renderApp('/dashboard');
    await screen.findByTestId('page-dashboard');
    await expect(container).toHaveNoViolations();
  });
});
