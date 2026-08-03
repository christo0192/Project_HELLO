/**
 * Login page — email/password with Google Workspace SSO.
 *
 * Public signup is NOT supported — only existing recruiter accounts, and
 * only with an allowlisted company account.
 *
 * Access model (enforced server-side by the API allowlist resolver):
 *   - The verified Supabase email must be an exact @interviewkickstart.com
 *     address present (and active) in the email_allowlist table.
 *   - Google Workspace (OAuth) is presented as the primary sign-in when
 *     VITE_SSO_PROVIDERS includes google. `hd` is never trusted client-side;
 *     the server re-checks the verified email on every request.
 *   - Errors are deliberately generic — they never distinguish "wrong
 *     domain" from "not allowlisted" from "no such account".
 *
 * The OAuth button does not fake a production setup: it only renders when
 * the environment actually configures the provider, and it redirects
 * through the normal Supabase flow.
 */

import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth, ALLOWED_EMAIL_DOMAIN, isCompanyEmail } from '../lib/auth';
import { Button, Card, Input, Label } from '../components/ui';

function getSsoProviders(): string[] {
  const raw = import.meta.env.VITE_SSO_PROVIDERS;
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Inline Google "G" mark — no external assets, safe for tests/offline. */
function GoogleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5">
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.46a5.53 5.53 0 0 1-2.4 3.63v3h3.87c2.27-2.09 3.59-5.17 3.59-8.82Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.87-3c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.29v3.1A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.28A7.2 7.2 0 0 1 4.9 12c0-.79.14-1.56.37-2.28V6.62H1.29a12 12 0 0 0 0 10.76l3.98-3.1Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.76c1.76 0 3.34.6 4.58 1.79l3.44-3.44A11.98 11.98 0 0 0 12 0 12 12 0 0 0 1.29 6.62l3.98 3.1C6.22 6.87 8.87 4.76 12 4.76Z"
      />
    </svg>
  );
}

export function LoginPage() {
  const { signIn, signInWithSSO, isAuthenticated, isLoading } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const ssoProviders = getSsoProviders();

  // If already authenticated at AAL2, redirect to candidates
  if (isAuthenticated) {
    return <Navigate to="/candidates" replace />;
  }

  // Soft UX hint only — the server is the sole enforcer.
  const companyHint =
    email.trim().length > 0 && !isCompanyEmail(email)
      ? `Company accounts only — use your @${ALLOWED_EMAIL_DOMAIN} email.`
      : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password) {
      setError('Email and password are required.');
      return;
    }
    setSubmitting(true);
    const { error: signInError } = await signIn(email.trim(), password);
    setSubmitting(false);
    if (signInError) {
      // Generic message — never leaks account existence or allowlist state.
      setError('Unable to sign in. Please check your details and try again.');
    }
  }

  async function handleSSO(provider: string) {
    setError(null);
    try {
      await signInWithSSO(provider);
    } catch {
      // Generic message — never leaks OAuth/allowlist configuration details.
      setError('Sign-in with Google is unavailable right now. Please try again later.');
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <Card className="w-full max-w-sm p-8">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-gray-200">
            {/* Brand logo on a neutral plate — never CSS-inverted. */}
            <img
              src="/ik-logo.png"
              alt="InterviewKickstart logo"
              className="h-10 w-10 object-contain"
            />
          </div>
          <h1 className="text-lg font-semibold text-gray-900">HELLO</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Talent Workspace &amp; Mission Control
          </p>
          <p className="mt-2 text-xs text-gray-400">Recruiter sign-in</p>
        </div>

        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div>
            <Label htmlFor="login-email">Email</Label>
            <Input
              id="login-email"
              type="email"
              autoComplete="email"
              placeholder={`you@${ALLOWED_EMAIL_DOMAIN}`}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
              required
              aria-required="true"
              aria-describedby={companyHint ? 'company-email-hint' : undefined}
            />
            {companyHint && (
              <p id="company-email-hint" className="mt-1 text-xs text-gray-500">
                {companyHint}
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="login-password">Password</Label>
            <Input
              id="login-password"
              type="password"
              autoComplete="current-password"
              placeholder="Enter your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              required
              aria-required="true"
            />
          </div>

          {error && (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          )}

          <Button type="submit" className="w-full" loading={submitting || isLoading}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        {ssoProviders.includes('google') && (
          <>
            <div className="my-4 flex items-center gap-3">
              <span className="h-px flex-1 bg-gray-200" />
              <span className="text-xs text-gray-400">or continue with</span>
              <span className="h-px flex-1 bg-gray-200" />
            </div>

            <Button
              type="button"
              variant="secondary"
              onClick={() => handleSSO('google')}
              disabled={submitting}
              className="w-full border-gray-300 font-medium text-gray-700"
            >
              <GoogleMark />
              <span>Continue with Google Workspace</span>
            </Button>
          </>
        )}

        <div className="mt-6 space-y-1.5 text-center">
          <p className="text-xs text-gray-400">
            Company-only access: sign in with your{' '}
            <span className="font-medium text-gray-500">
              @{ALLOWED_EMAIL_DOMAIN}
            </span>{' '}
            Google Workspace account.
          </p>
          <p className="text-xs text-gray-400">
            Access is limited to authorised team members. Sign-up is not
            available.
          </p>
        </div>
      </Card>
    </div>
  );
}
