/**
 * ProtectedRoute tests.
 *
 * Verifies:
 *   - Loading state while auth check is in progress
 *   - Redirects to /login when no session
 *   - Redirects to /mfa/enroll when AAL1 with no factors
 *   - Redirects to /mfa/challenge when AAL1 with verified factors
 *   - Renders children when AAL2 (full auth)
 */

import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { ProtectedRoute } from './ProtectedRoute';

// ── Mock useAuth ───────────────────────────────────────────────────────

function createMockAuth(overrides: Record<string, any> = {}) {
  return {
    isLoading: false,
    isAuthenticated: false,
    needsMfa: false,
    factors: [] as Array<{ id: string; type: 'totp' }>,
    user: null,
    session: null,
    aal: null as ('aal1' | 'aal2' | null),
    signIn: vi.fn(),
    signOut: vi.fn(),
    signInWithSSO: vi.fn(),
    enrollMfa: vi.fn(),
    challengeMfa: vi.fn(),
    refreshSession: vi.fn(),
    ...overrides,
  };
}

let mockAuth: ReturnType<typeof createMockAuth>;

vi.mock('../lib/auth', () => ({
  useAuth: () => mockAuth,
}));

// ── Test harness ───────────────────────────────────────────────────────

function renderProtectedRoute(initialEntry = '/protected') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/protected" element={<div data-testid="protected-content">Dashboard</div>} />
        </Route>
        <Route path="/login" element={<div data-testid="login-page">Login</div>} />
        <Route path="/mfa/enroll" element={<div data-testid="mfa-enroll">MFA Enroll</div>} />
        <Route path="/mfa/challenge" element={<div data-testid="mfa-challenge">MFA Challenge</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProtectedRoute', () => {
  beforeEach(() => {
    mockAuth = createMockAuth();
  });

  it('shows loading state while auth is being checked', () => {
    mockAuth.isLoading = true;
    renderProtectedRoute();

    expect(screen.getByText('Checking session…')).toBeInTheDocument();
    expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
  });

  it('redirects to /login when no session', async () => {
    mockAuth.isLoading = false;
    mockAuth.isAuthenticated = false;
    mockAuth.needsMfa = false;

    renderProtectedRoute();

    await waitFor(() => {
      expect(screen.getByTestId('login-page')).toBeInTheDocument();
    });
  });

  it('redirects to /mfa/enroll when AAL1 with no factors', async () => {
    mockAuth.isLoading = false;
    mockAuth.isAuthenticated = false;
    mockAuth.needsMfa = true;
    mockAuth.factors = [];

    renderProtectedRoute();

    await waitFor(() => {
      expect(screen.getByTestId('mfa-enroll')).toBeInTheDocument();
    });
  });

  it('redirects to /mfa/challenge when AAL1 with verified factors', async () => {
    mockAuth.isLoading = false;
    mockAuth.isAuthenticated = false;
    mockAuth.needsMfa = true;
    mockAuth.factors = [{ id: 'f1', type: 'totp' }];

    renderProtectedRoute();

    await waitFor(() => {
      expect(screen.getByTestId('mfa-challenge')).toBeInTheDocument();
    });
  });

  it('renders protected content when AAL2', () => {
    mockAuth.isLoading = false;
    mockAuth.isAuthenticated = true;
    mockAuth.needsMfa = false;
    mockAuth.aal = 'aal2';
    mockAuth.session = { access_token: 'tok' } as any;

    renderProtectedRoute();

    expect(screen.getByTestId('protected-content')).toBeInTheDocument();
    expect(screen.queryByTestId('login-page')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mfa-enroll')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mfa-challenge')).not.toBeInTheDocument();
  });

  it('has loading axe accessibility', async () => {
    mockAuth.isLoading = true;
    const { container } = renderProtectedRoute();

    await expect(container).toHaveNoViolations();
  });
});
