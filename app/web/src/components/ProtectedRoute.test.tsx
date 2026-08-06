/**
 * ProtectedRoute tests — ADR-0011 (single factor, allowlist authorization).
 *
 * Verifies:
 *   - Loading state while the session check is in progress
 *   - Redirects to /login when there is no session
 *   - NO MFA redirects: /mfa/enroll and /mfa/challenge are never targeted
 *   - Renders protected content for a valid session with a resolved role
 *   - No recruiter/candidate data flashes before the role resolves
 *   - A resolved null role (revoked entry / stale session / API failure)
 *     fails closed to /unauthorized
 *   - requireRole gate still enforced
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
    needsMfa: false, // ADR-0011: always false
    factors: [] as Array<{ id: string; type: 'totp' }>,
    user: null,
    session: null,
    aal: null as ('aal1' | 'aal2' | null),
    role: null as ('admin' | 'interviewer' | 'viewer' | null),
    isRoleLoading: false,
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

/** A valid single-factor session with a resolved role. */
function authedWithRole(role: 'admin' | 'interviewer' | 'viewer') {
  mockAuth.isLoading = false;
  mockAuth.isAuthenticated = true;
  mockAuth.aal = 'aal1'; // single factor — must be sufficient
  mockAuth.session = { access_token: 'tok' } as any;
  mockAuth.isRoleLoading = false;
  mockAuth.role = role;
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

    renderProtectedRoute();

    await waitFor(() => {
      expect(screen.getByTestId('login-page')).toBeInTheDocument();
    });
  });

  it('renders protected content for a single-factor (aal1) session with a resolved role', () => {
    authedWithRole('viewer');

    renderProtectedRoute();

    expect(screen.getByTestId('protected-content')).toBeInTheDocument();
    expect(screen.queryByTestId('login-page')).not.toBeInTheDocument();
  });

  // ── ADR-0011: MFA routes are never targeted ──────────────────────
  describe('ADR-0011: no MFA redirects', () => {
    it('never redirects to /mfa/enroll for an aal1 session with no factors', async () => {
      authedWithRole('admin');
      mockAuth.factors = [];

      renderProtectedRoute();

      await waitFor(() => {
        expect(screen.getByTestId('protected-content')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('mfa-enroll')).not.toBeInTheDocument();
      expect(screen.queryByTestId('mfa-challenge')).not.toBeInTheDocument();
    });

    it('never redirects to /mfa/challenge even when verified factors exist', async () => {
      authedWithRole('admin');
      mockAuth.factors = [{ id: 'f1', type: 'totp' }];

      renderProtectedRoute();

      await waitFor(() => {
        expect(screen.getByTestId('protected-content')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('mfa-challenge')).not.toBeInTheDocument();
      expect(screen.queryByTestId('mfa-enroll')).not.toBeInTheDocument();
    });
  });

  // ── No data flash before role resolution ─────────────────────────
  describe('no data flashes before role resolution', () => {
    it('renders no content while the role is still resolving (ungated route)', () => {
      mockAuth.isLoading = false;
      mockAuth.isAuthenticated = true;
      mockAuth.session = { access_token: 'tok' } as any;
      mockAuth.isRoleLoading = true;
      mockAuth.role = null;

      renderProtectedRoute();

      expect(screen.getByText('Checking access…')).toBeInTheDocument();
      expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
      expect(screen.queryByTestId('unauthorized-page')).not.toBeInTheDocument();
    });

    it('renders no content while the role is still resolving (role-gated route)', () => {
      mockAuth.isLoading = false;
      mockAuth.isAuthenticated = true;
      mockAuth.session = { access_token: 'tok' } as any;
      mockAuth.isRoleLoading = true;
      mockAuth.role = null;

      renderProtectedRoute('/admin', 'admin');

      expect(screen.getByText('Checking access…')).toBeInTheDocument();
      expect(screen.queryByTestId('admin-content')).not.toBeInTheDocument();
      expect(screen.queryByTestId('unauthorized-page')).not.toBeInTheDocument();
    });
  });

  // ── Stale session / revoked allowlist entry fails closed ─────────
  describe('stale session fails closed', () => {
    it('redirects to /unauthorized when the role resolved to null (revoked/denied)', async () => {
      mockAuth.isLoading = false;
      mockAuth.isAuthenticated = true;
      mockAuth.session = { access_token: 'tok' } as any;
      mockAuth.isRoleLoading = false;
      mockAuth.role = null; // /api/me denied — allowlist entry revoked

      renderProtectedRoute();

      await waitFor(() => {
        expect(screen.getByTestId('unauthorized-page')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
    });

    it('never renders admin content for a stale session on a gated route', async () => {
      mockAuth.isLoading = false;
      mockAuth.isAuthenticated = true;
      mockAuth.session = { access_token: 'tok' } as any;
      mockAuth.isRoleLoading = false;
      mockAuth.role = null;

      renderProtectedRoute('/admin', 'admin');

      await waitFor(() => {
        expect(screen.getByTestId('unauthorized-page')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('admin-content')).not.toBeInTheDocument();
    });
  });

  it('has loading axe accessibility', async () => {
    mockAuth.isLoading = true;
    const { container } = renderProtectedRoute();

    await expect(container).toHaveNoViolations();
  });

  // ── Phase 9 L4: role gate (UX only; APIs authoritative) ───────────
  describe('requireRole gate (Phase 9)', () => {
    it('renders admin content for an admin with resolved role', () => {
      authedWithRole('admin');
      renderProtectedRoute('/admin', 'admin');
      expect(screen.getByTestId('admin-content')).toBeInTheDocument();
    });

    it('redirects non-admin to /unauthorized', async () => {
      authedWithRole('interviewer');
      renderProtectedRoute('/admin', 'admin');
      await waitFor(() => {
        expect(screen.getByTestId('unauthorized-page')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('admin-content')).not.toBeInTheDocument();
    });

    it('redirects a viewer to /unauthorized on an admin route', async () => {
      authedWithRole('viewer');
      renderProtectedRoute('/admin', 'admin');
      await waitFor(() => {
        expect(screen.getByTestId('unauthorized-page')).toBeInTheDocument();
      });
    });
  });
});
