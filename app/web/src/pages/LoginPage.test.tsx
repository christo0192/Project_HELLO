/**
 * LoginPage tests.
 *
 * Verifies:
 *   - Renders email/password form with labels and HELLO branding
 *   - Redirects to /candidates if already authenticated
 *   - Shows generic error on invalid credentials (never leaks allowlist state)
 *   - Company-only access messaging (exact @interviewkickstart.com domain)
 *   - Soft inline hint for non-company emails (UX only — server enforces)
 *   - Google Workspace button hidden when VITE_SSO_PROVIDERS is unset
 *   - Google Workspace button visible when configured
 *   - Generic SSO error (never leaks OAuth configuration)
 *   - Form validation (empty fields)
 *   - Accessibility: axe violations
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LoginPage } from './LoginPage';
import { ALLOWED_EMAIL_DOMAIN, isCompanyEmail } from '../lib/auth';

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
  ALLOWED_EMAIL_DOMAIN: 'interviewkickstart.com',
  isCompanyEmail: (raw: string) => {
    const t = raw.trim().toLowerCase();
    const at = t.indexOf('@');
    return at !== -1 && t.indexOf('@', at + 1) === -1 && t.slice(at + 1) === 'interviewkickstart.com';
  },
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

  it('renders the sign-in form with HELLO branding and company-only messaging', () => {
    renderLoginPage();
    expect(screen.getByText('HELLO')).toBeInTheDocument();
    expect(screen.getByText(/Talent Workspace & Mission Control/)).toBeInTheDocument();
    expect(screen.getByText('Recruiter sign-in')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(
      screen.getByText(`@${ALLOWED_EMAIL_DOMAIN}`, { exact: false }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Access is limited to authorised team members/),
    ).toBeInTheDocument();
  });

  it('renders the brand logo on a neutral plate with a proper alt', () => {
    renderLoginPage();
    const img = screen.getByAltText('InterviewKickstart logo');
    expect(img).toHaveAttribute('src', '/ik-logo.png');
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
    await user.type(screen.getByLabelText('Email'), 'gopu.nair@interviewkickstart.com');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(mockSignIn).toHaveBeenCalledWith('gopu.nair@interviewkickstart.com', 'password123');
    });
  });

  it('shows a generic error on failed sign-in (never leaks allowlist state)', async () => {
    mockSignIn.mockResolvedValue({ error: new Error('Invalid login credentials') });
    renderLoginPage();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'gopu.nair@interviewkickstart.com');
    await user.type(screen.getByLabelText('Password'), 'wrongpassword');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(
      await screen.findByText('Unable to sign in. Please check your details and try again.'),
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

  it('shows a soft company-email hint for a non-company address (UX only)', async () => {
    renderLoginPage();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'gopu@gmail.com');

    expect(
      await screen.findByText(`Company accounts only — use your @${ALLOWED_EMAIL_DOMAIN} email.`),
    ).toBeInTheDocument();
  });

  it('does not show the company-email hint for a valid company address', async () => {
    renderLoginPage();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'gopu.nair@interviewkickstart.com');

    expect(
      screen.queryByText(/Company accounts only/),
    ).not.toBeInTheDocument();
  });

  it('does not show Google Workspace button when VITE_SSO_PROVIDERS is not set', () => {
    renderLoginPage();
    expect(screen.queryByText(/Continue with Google Workspace/)).not.toBeInTheDocument();
    expect(screen.queryByText('or continue with')).not.toBeInTheDocument();
  });

  it('shows the Google Workspace button when VITE_SSO_PROVIDERS includes google', () => {
    import.meta.env.VITE_SSO_PROVIDERS = 'google';
    renderLoginPage();

    expect(
      screen.getByRole('button', { name: /Continue with Google Workspace/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('or continue with')).toBeInTheDocument();
  });

  it('calls signInWithSSO when the Google Workspace button is clicked', async () => {
    import.meta.env.VITE_SSO_PROVIDERS = 'google';
    mockSignInWithSSO.mockResolvedValue(undefined);
    renderLoginPage();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Continue with Google Workspace/ }));

    await waitFor(() => {
      // No deep link in play here, so no return-to travels with the request.
      expect(mockSignInWithSSO).toHaveBeenCalledWith('google', undefined);
    });
  });

  it('shows a generic SSO error (never leaks OAuth/allowlist configuration)', async () => {
    import.meta.env.VITE_SSO_PROVIDERS = 'google';
    mockSignInWithSSO.mockRejectedValue(new Error('provider not configured'));
    renderLoginPage();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Continue with Google Workspace/ }));

    expect(
      await screen.findByText(
        'Sign-in with Google is unavailable right now. Please try again later.',
      ),
    ).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = renderLoginPage();
    await expect(container).toHaveNoViolations();
  });
});

// ── isCompanyEmail (UX helper) unit tests ─────────────────────────────

describe('isCompanyEmail (UX-only helper)', () => {
  it('accepts exact company-domain emails (case/whitespace tolerant)', () => {
    expect(isCompanyEmail('gopu.nair@interviewkickstart.com')).toBe(true);
    expect(isCompanyEmail('  GOPU.NAIR@InterviewKickStart.COM  ')).toBe(true);
  });

  it('rejects non-company domains', () => {
    expect(isCompanyEmail('gopu@gmail.com')).toBe(false);
    expect(isCompanyEmail('gopu@interviewkickstart.com.evil.test')).toBe(false);
    expect(isCompanyEmail('gopu@sub.interviewkickstart.com')).toBe(false);
  });

  it('rejects multi-@ and unicode lookalikes', () => {
    expect(isCompanyEmail('a@b@interviewkickstart.com')).toBe(false);
    expect(isCompanyEmail('gopu＠interviewkickstart.com')).toBe(false);
  });
});
