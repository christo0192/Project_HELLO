/**
 * LoginPage tests.
 *
 * Verifies:
 *   - Renders email/password form with labels
 *   - Redirects to /candidates if already authenticated
 *   - Shows error on invalid credentials
 *   - SSO buttons hidden when VITE_SSO_PROVIDERS is unset
 *   - SSO buttons visible when configured
 *   - Form validation (empty fields)
 *   - Accessibility: axe violations
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LoginPage } from './LoginPage';

// ── Mock useAuth ───────────────────────────────────────────────────────

let mockSignIn = vi.fn();
let mockSignInWithSSO = vi.fn();
let mockIsAuthenticated = false;

vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    signIn: mockSignIn,
    signInWithSSO: mockSignInWithSSO,
    isAuthenticated: mockIsAuthenticated,
    isLoading: false,
  }),
}));

function renderLoginPage() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/candidates" element={<div data-testid="candidates-page">Candidates</div>} />
        <Route path="/mfa/enroll" element={<div data-testid="mfa-enroll">MFA Enroll</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSignIn = vi.fn();
    mockSignInWithSSO = vi.fn();
    mockIsAuthenticated = false;
    delete import.meta.env.VITE_SSO_PROVIDERS;
  });

  afterEach(() => {
    delete import.meta.env.VITE_SSO_PROVIDERS;
  });

  it('renders the sign-in form', () => {
    renderLoginPage();
    expect(screen.getByText('Maya Screen')).toBeInTheDocument();
    expect(screen.getByText('Recruiter sign-in')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('redirects to /candidates if already authenticated', async () => {
    mockIsAuthenticated = true;
    renderLoginPage();

    await waitFor(() => {
      expect(screen.getByTestId('candidates-page')).toBeInTheDocument();
    });
  });

  it('calls signIn on form submit', async () => {
    mockSignIn.mockResolvedValue({ error: null });
    renderLoginPage();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'test@example.com');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(mockSignIn).toHaveBeenCalledWith('test@example.com', 'password123');
    });
  });

  it('shows generic error on failed sign-in', async () => {
    mockSignIn.mockResolvedValue({ error: new Error('Invalid login credentials') });
    renderLoginPage();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'test@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrongpassword');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(
      await screen.findByText(
        'Invalid credentials. Please check your email and password.',
      ),
    ).toBeInTheDocument();
  });

  it('shows validation error for empty fields', async () => {
    renderLoginPage();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(
      await screen.findByText('Email and password are required.'),
    ).toBeInTheDocument();
  });

  it('does not show SSO buttons when VITE_SSO_PROVIDERS is not set', () => {
    renderLoginPage();
    expect(screen.queryByText('Google')).not.toBeInTheDocument();
    expect(screen.queryByText('GitHub')).not.toBeInTheDocument();
    expect(screen.queryByText('or continue with')).not.toBeInTheDocument();
  });

  it('shows SSO buttons when VITE_SSO_PROVIDERS is set', () => {
    import.meta.env.VITE_SSO_PROVIDERS = 'google,github';
    renderLoginPage();

    expect(screen.getByText('Google')).toBeInTheDocument();
    expect(screen.getByText('GitHub')).toBeInTheDocument();
    expect(screen.getByText('or continue with')).toBeInTheDocument();
  });

  it('calls signInWithSSO when SSO button clicked', async () => {
    import.meta.env.VITE_SSO_PROVIDERS = 'google';
    mockSignInWithSSO.mockResolvedValue(undefined);
    renderLoginPage();

    const user = userEvent.setup();
    await user.click(screen.getByText('Google'));

    await waitFor(() => {
      expect(mockSignInWithSSO).toHaveBeenCalledWith('google');
    });
  });

  it('shows message noting sign-up is not available', () => {
    renderLoginPage();
    expect(
      screen.getByText('Authorised recruiters only. Sign-up is not available.'),
    ).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = renderLoginPage();
    await expect(container).toHaveNoViolations();
  });
});
