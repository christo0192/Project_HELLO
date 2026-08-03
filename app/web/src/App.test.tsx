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
    expect(await screen.findByTestId('page-dashboard')).toBeInTheDocument();
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
