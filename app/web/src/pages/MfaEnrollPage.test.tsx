/**
 * MfaEnrollPage tests.
 *
 * Verifies:
 *   - Shows setup CTA when not enrolled
 *   - Displays secret key after enrollment
 *   - Verifies code and upgrades to AAL2
 *   - Redirects if already AAL2
 *   - Redirects to /login if no session
 *   - Redirects to /mfa/challenge if factors already exist
 *   - Accessibility: axe violations
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MfaEnrollPage } from './MfaEnrollPage';

// ── Mock useAuth ───────────────────────────────────────────────────────

let mockEnrollMfa = vi.fn();
let mockChallengeMfa = vi.fn();
let mockRefreshSession = vi.fn();
let mockIsLoading = false;
let mockNeedsMfa = true;
let mockIsAuthenticated = false;
let mockFactors: { id: string; type: 'totp' }[] = [];

vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    enrollMfa: mockEnrollMfa,
    challengeMfa: mockChallengeMfa,
    refreshSession: mockRefreshSession,
    isLoading: mockIsLoading,
    needsMfa: mockNeedsMfa,
    isAuthenticated: mockIsAuthenticated,
    factors: mockFactors,
  }),
}));

function renderMfaEnrollPage() {
  return render(
    <MemoryRouter initialEntries={['/mfa/enroll']}>
      <Routes>
        <Route path="/mfa/enroll" element={<MfaEnrollPage />} />
        <Route path="/candidates" element={<div data-testid="candidates-page">Candidates</div>} />
        <Route path="/login" element={<div data-testid="login-page">Login</div>} />
        <Route path="/mfa/challenge" element={<div data-testid="mfa-challenge">MFA Challenge</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('MfaEnrollPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnrollMfa = vi.fn();
    mockChallengeMfa = vi.fn();
    mockRefreshSession = vi.fn();
    mockIsLoading = false;
    mockNeedsMfa = true;
    mockIsAuthenticated = false;
    mockFactors = [];
  });

  it('shows enrollment CTA when not enrolled', () => {
    renderMfaEnrollPage();

    expect(
      screen.getByText('Two-factor authentication'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'You need to set up multi-factor authentication before accessing the recruiter dashboard.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Set up authenticator app' }),
    ).toBeInTheDocument();
  });

  it('shows secret and verify form after enrollment', async () => {
    mockEnrollMfa.mockResolvedValue({
      error: null,
      factor: { id: 'f1', type: 'totp' },
      totpUri: 'otpauth://totp/test',
      secret: 'JBSWY3DPEHPK3PXP',
    });

    renderMfaEnrollPage();

    const user = userEvent.setup();
    await user.click(
      screen.getByRole('button', { name: 'Set up authenticator app' }),
    );

    await waitFor(() => {
      expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
      expect(screen.getByLabelText('Verification code')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Verify & continue' }),
      ).toBeInTheDocument();
    });
  });

  it('verifies code and calls refreshSession', async () => {
    mockEnrollMfa.mockResolvedValue({
      error: null,
      factor: { id: 'f1', type: 'totp' },
      secret: 'SECRET',
    });
    mockChallengeMfa.mockResolvedValue({ error: null, verified: true });

    renderMfaEnrollPage();

    // Enroll first
    const user = userEvent.setup();
    await user.click(
      screen.getByRole('button', { name: 'Set up authenticator app' }),
    );

    await waitFor(() => {
      expect(screen.getByText('SECRET')).toBeInTheDocument();
    });

    // Enter code and verify
    await user.type(screen.getByLabelText('Verification code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify & continue' }));

    await waitFor(() => {
      expect(mockChallengeMfa).toHaveBeenCalledWith('123456');
      expect(mockRefreshSession).toHaveBeenCalled();
    });
  });

  it('shows error for invalid verification code', async () => {
    mockEnrollMfa.mockResolvedValue({
      error: null,
      factor: { id: 'f1', type: 'totp' },
      secret: 'SECRET',
    });
    mockChallengeMfa.mockResolvedValue({
      error: new Error('Invalid code'),
      verified: false,
    });

    renderMfaEnrollPage();

    const user = userEvent.setup();
    await user.click(
      screen.getByRole('button', { name: 'Set up authenticator app' }),
    );

    await waitFor(() => {
      expect(screen.getByText('SECRET')).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText('Verification code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Verify & continue' }));

    await waitFor(() => {
      expect(screen.getByText('Invalid code. Please try again.'));
    });
  });

  it('redirects to /candidates if already AAL2', async () => {
    mockIsAuthenticated = true;
    renderMfaEnrollPage();

    await waitFor(() => {
      expect(screen.getByTestId('candidates-page')).toBeInTheDocument();
    });
  });

  it('redirects to /login if no session', async () => {
    mockNeedsMfa = false;
    renderMfaEnrollPage();

    await waitFor(() => {
      expect(screen.getByTestId('login-page')).toBeInTheDocument();
    });
  });

  it('redirects to /mfa/challenge if factors already exist', async () => {
    mockFactors = [{ id: 'f1', type: 'totp' }];
    renderMfaEnrollPage();

    await waitFor(() => {
      expect(screen.getByTestId('mfa-challenge')).toBeInTheDocument();
    });
  });

  it('shows loading spinner while auth is being checked', () => {
    mockIsLoading = true;
    renderMfaEnrollPage();

    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  });

  it('has no axe violations on initial state', async () => {
    const { container } = renderMfaEnrollPage();
    await expect(container).toHaveNoViolations();
  });
});
