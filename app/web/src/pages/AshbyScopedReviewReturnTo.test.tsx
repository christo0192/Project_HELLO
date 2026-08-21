/**
 * Logged-out deep link → login → back to the scoped review.
 *
 * Covers the full round trip end of the contract:
 *   - an unauthenticated hit on /ashby/review/<uuid> renders NO candidate
 *     content and lands on /login;
 *   - the destination travels in router STATE (never a `?next=` query), and
 *     only when it passes the exact path allowlist;
 *   - after sign-in the login page returns to the validated path, and falls
 *     back to /candidates for anything else — including a hostile state value
 *     injected directly, since state is not a trust boundary.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProtectedRoute } from '../components/ProtectedRoute';
import { LoginPage } from './LoginPage';
import { PostAuthLanding } from '../App';
import { rememberReturnTo, resetReturnToReplay } from '../lib/return-to';

const UUID = '11111111-1111-4111-8111-111111111111';
const REVIEW_PATH = `/ashby/review/${UUID}`;

let mockAuth: Record<string, any>;

vi.mock('../lib/auth', () => ({
  useAuth: () => mockAuth,
  ALLOWED_EMAIL_DOMAIN: 'interviewkickstart.com',
  isCompanyEmail: () => true,
}));

/** Login stand-in that exposes the router state the guard handed over. */
function LoginProbe() {
  const location = useLocation();
  const state = location.state as { returnTo?: string } | null;
  return (
    <div>
      <p data-testid="login-page">Login</p>
      <p data-testid="return-to">{state?.returnTo ?? 'none'}</p>
      <p data-testid="search">{location.search || 'none'}</p>
    </div>
  );
}

function renderGuarded(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/ashby/review/:applicationLinkId" element={<div data-testid="scoped-review">Jane Doe</div>} />
          <Route path="/candidates" element={<div data-testid="candidates-page">Candidates</div>} />
        </Route>
        <Route path="/login" element={<LoginProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Real LoginPage, entered with an explicit router state. */
function renderLoginWithState(state: unknown) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/login', state }]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/candidates" element={<div data-testid="candidates-page">Candidates</div>} />
        <Route path="/ashby/review/:applicationLinkId" element={<div data-testid="scoped-review">Jane Doe</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetReturnToReplay();
  window.sessionStorage.clear();
  mockAuth = {
    isLoading: false,
    isAuthenticated: false,
    isRoleLoading: false,
    role: null,
    signIn: vi.fn(),
    signInWithSSO: vi.fn(),
  };
});

describe('logged-out deep link', () => {
  it('redirects to /login and renders no candidate content', async () => {
    renderGuarded(REVIEW_PATH);
    await waitFor(() => expect(screen.getByTestId('login-page')).toBeInTheDocument());
    expect(screen.queryByTestId('scoped-review')).toBeNull();
  });

  it('preserves the destination in router state and never in a query parameter', async () => {
    renderGuarded(REVIEW_PATH);
    await waitFor(() => expect(screen.getByTestId('return-to')).toHaveTextContent(REVIEW_PATH));
    expect(screen.getByTestId('search')).toHaveTextContent('none');
  });

  it('drops a non-allowlisted origin path (no return-to for /candidates)', async () => {
    renderGuarded('/candidates');
    await waitFor(() => expect(screen.getByTestId('login-page')).toBeInTheDocument());
    expect(screen.getByTestId('return-to')).toHaveTextContent('none');
  });

  it('drops a malformed link id', async () => {
    renderGuarded('/ashby/review/not-a-uuid');
    await waitFor(() => expect(screen.getByTestId('login-page')).toBeInTheDocument());
    expect(screen.getByTestId('return-to')).toHaveTextContent('none');
  });
});

describe('login return-to handling', () => {
  it('returns an authenticated user to the validated scoped review path', async () => {
    mockAuth.isAuthenticated = true;
    renderLoginWithState({ returnTo: REVIEW_PATH });
    await waitFor(() => expect(screen.getByTestId('scoped-review')).toBeInTheDocument());
  });

  it.each([
    ['absolute URL', 'https://evil.example/ashby/review/' + UUID],
    ['protocol-relative host', '//evil.example/'],
    ['unlisted app path', '/mission-control'],
    ['path with a query', `/ashby/review/${UUID}?next=https://evil.example`],
  ])('falls back to /candidates for a hostile state value (%s)', async (_label, value) => {
    mockAuth.isAuthenticated = true;
    renderLoginWithState({ returnTo: value });
    await waitFor(() => expect(screen.getByTestId('candidates-page')).toBeInTheDocument());
    expect(screen.queryByTestId('scoped-review')).toBeNull();
  });

  it('falls back to /candidates with no state at all (unchanged default)', async () => {
    mockAuth.isAuthenticated = true;
    renderLoginWithState(undefined);
    await waitFor(() => expect(screen.getByTestId('candidates-page')).toBeInTheDocument());
  });
});

/**
 * The SSO path — a FULL-PAGE redirect to the identity provider and back.
 *
 * Router state does not survive that navigation, so without this the deep link
 * was silently dropped for every deployment with VITE_SSO_PROVIDERS configured
 * and the recruiter landed on the dashboard. The destination now travels two
 * ways, both re-validated by `sanitizeReturnTo`: on the provider redirect URL,
 * and parked in sessionStorage for the deployment where Supabase falls back to
 * the site URL.
 */
describe('SSO deep-link return-to', () => {
  const NOW_PATH = REVIEW_PATH;

  afterEach(() => {
    delete import.meta.env.VITE_SSO_PROVIDERS;
  });

  function renderLoginForSSO(state: unknown) {
    import.meta.env.VITE_SSO_PROVIDERS = 'google';
    return renderLoginWithState(state);
  }

  it('hands the validated destination to the provider AND parks it', async () => {
    renderLoginForSSO({ returnTo: NOW_PATH });
    await userEvent.click(screen.getByRole('button', { name: /continue with google/i }));

    expect(mockAuth.signInWithSSO).toHaveBeenCalledWith('google', NOW_PATH);
    const parked = window.sessionStorage.getItem('ashby.returnTo');
    expect(parked).not.toBeNull();
    expect(JSON.parse(parked!).p).toBe(NOW_PATH);
  });

  it('parks nothing and passes nothing for a hostile state value', async () => {
    renderLoginForSSO({ returnTo: 'https://evil.example/ashby/review/' + UUID });
    await userEvent.click(screen.getByRole('button', { name: /continue with google/i }));

    expect(mockAuth.signInWithSSO).toHaveBeenCalledWith('google', undefined);
    expect(window.sessionStorage.getItem('ashby.returnTo')).toBeNull();
  });

  it('parks nothing when there is no deep link at all', async () => {
    renderLoginForSSO(undefined);
    await userEvent.click(screen.getByRole('button', { name: /continue with google/i }));

    expect(mockAuth.signInWithSSO).toHaveBeenCalledWith('google', undefined);
    expect(window.sessionStorage.getItem('ashby.returnTo')).toBeNull();
  });
});

/** The post-SSO landing route consumes the parked destination once. */
describe('post-SSO landing', () => {
  function renderLanding() {
    return render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<PostAuthLanding />} />
          <Route path="/dashboard" element={<div data-testid="dashboard-page">Dashboard</div>} />
          <Route path="/ashby/review/:applicationLinkId" element={<div data-testid="scoped-review">Jane Doe</div>} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('returns the recruiter to the exact scoped review they clicked', async () => {
    rememberReturnTo(REVIEW_PATH);
    renderLanding();
    await waitFor(() => expect(screen.getByTestId('scoped-review')).toBeInTheDocument());
  });

  it('lands on the dashboard when nothing was parked (unchanged default)', async () => {
    renderLanding();
    await waitFor(() => expect(screen.getByTestId('dashboard-page')).toBeInTheDocument());
  });

  it('lands on the dashboard for a tampered storage entry', async () => {
    window.sessionStorage.setItem(
      'ashby.returnTo',
      JSON.stringify({ p: 'https://evil.example/', t: Date.now() }),
    );
    renderLanding();
    await waitFor(() => expect(screen.getByTestId('dashboard-page')).toBeInTheDocument());
    expect(screen.queryByTestId('scoped-review')).toBeNull();
  });
});
