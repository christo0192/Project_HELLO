/**
 * MfaChallengePage tests.
 *
 * Verifies:
 *   - Renders code input form
 *   - Redirects to /candidates if already AAL2
 *   - Redirects to /login if no session at all
 *   - Shows error on invalid code
 *   - Calls challengeMfa on submit
 *   - Shows loading spinner while auth check is in progress
 *   - Accessibility: axe violations
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MfaChallengePage } from './MfaChallengePage';

// ── Mock useAuth ───────────────────────────────────────────────────────

let mockChallengeMfa = vi.fn();
let mockRefreshSession = vi.fn();
let mockIsLoading = false;
let mockNeedsMfa = true;
let mockIsAuthenticated = false;

vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    challengeMfa: mockChallengeMfa,
    refreshSession: mockRefreshSession,
    isLoading: mockIsLoading,
    needsMfa: mockNeedsMfa,
    isAuthenticated: mockIsAuthenticated,
  }),
}));

function renderMfaChallengePage() {
  return render(
    <MemoryRouter initialEntries={['/mfa/challenge']}>
      <Routes>
        <Route path="/mfa/challenge" element={<MfaChallengePage />} />
        <Route path="/candidates" element={<div data-testid="candidates-page">Candidates</div>} />
        <Route path="/login" element={<div data-testid="login-page">Login</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('MfaChallengePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChallengeMfa = vi.fn();
    mockRefreshSession = vi.fn();
    mockIsLoading = false;
    mockNeedsMfa = true;
    mockIsAuthenticated = false;
  });

  it('renders the challenge form', () => {
    renderMfaChallengePage();
    expect(
      screen.getByText('Two-factor authentication'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Enter the 6-digit code from your authenticator app.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText('Authentication code'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Verify' })).toBeInTheDocument();
  });

  it('redirects to /candidates if already AAL2', async () => {
    mockIsAuthenticated = true;
    renderMfaChallengePage();

    await waitFor(() => {
      expect(screen.getByTestId('candidates-page')).toBeInTheDocument();
    });
  });

  it('redirects to /login if no session', async () => {
    mockNeedsMfa = false;
    renderMfaChallengePage();

    await waitFor(() => {
      expect(screen.getByTestId('login-page')).toBeInTheDocument();
    });
  });

  it('calls challengeMfa with the code and refreshes on success', async () => {
    mockChallengeMfa.mockResolvedValue({ error: null, verified: true });
    renderMfaChallengePage();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Authentication code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => {
      expect(mockChallengeMfa).toHaveBeenCalledWith('123456');
      expect(mockRefreshSession).toHaveBeenCalled();
    });
  });

  it('shows error for invalid code', async () => {
    mockChallengeMfa.mockResolvedValue({
      error: new Error('Invalid code'),
      verified: false,
    });
    renderMfaChallengePage();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Authentication code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    expect(
      await screen.findByText('Invalid code. Please try again.'),
    ).toBeInTheDocument();
  });

  it('shows error for empty code', async () => {
    renderMfaChallengePage();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    // The form's handleSubmit validates empty code and sets error
    // Error may appear after React state flush
    await waitFor(() => {
      expect(
        screen.getByText(
          'Please enter the 6-digit code from your authenticator app.',
        ),
      ).toBeInTheDocument();
    });
  });

  it('shows loading spinner while auth is being checked', () => {
    mockIsLoading = true;
    renderMfaChallengePage();

    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = renderMfaChallengePage();
    await expect(container).toHaveNoViolations();
  });
});
