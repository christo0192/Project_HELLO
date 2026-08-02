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
    role: null as ('admin' | 'interviewer' | 'viewer' | null),
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

function renderProtectedRoute(initialEntry = '/protected', requireRole?: 'admin') {
  const guard = requireRole ? (
    <ProtectedRoute requireRole={requireRole} />
  ) : (
    <ProtectedRoute />
  );
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route element={guard}>
          <Route path="/protected" element={<div data-testid="protected-content">Dashboard</div>} />
          <Route path="/admin" element={<div data-testid="admin-content">Admin</div>} />
        </Route>
        <Route path="/login" element={<div data-testid="login-page">Login</div>} />
        <Route path="/unauthorized" element={<div data-testid="unauthorized-page">Unauthorized</div>} />
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

  // ── Phase 9 L4: role gate (UX only; APIs authoritative) ───────────
  describe('requireRole gate (Phase 9)', () => {
    function authedAal2() {
      mockAuth.isLoading = false;
      mockAuth.isAuthenticated = true;
      mockAuth.needsMfa = false;
      mockAuth.aal = 'aal2';
      mockAuth.session = { access_token: 'tok' } as any;
    }

    it('fails closed while the authoritative role is unresolved (no content, no redirect)', () => {
      authedAal2();
      mockAuth.role = null;
      renderProtectedRoute('/admin', 'admin');
      expect(screen.getByText('Checking access…')).toBeInTheDocument();
      expect(screen.queryByTestId('admin-content')).not.toBeInTheDocument();
      expect(screen.queryByTestId('unauthorized-page')).not.toBeInTheDocument();
    });

    it('renders admin content for an admin with resolved role', () => {
      authedAal2();
      mockAuth.role = 'admin';
      renderProtectedRoute('/admin', 'admin');
      expect(screen.getByTestId('admin-content')).toBeInTheDocument();
    });

    it('redirects non-admin to /unauthorized', async () => {
      authedAal2();
      mockAuth.role = 'interviewer';
      renderProtectedRoute('/admin', 'admin');
      await waitFor(() => {
        expect(screen.getByTestId('unauthorized-page')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('admin-content')).not.toBeInTheDocument();
    });
  });
});
