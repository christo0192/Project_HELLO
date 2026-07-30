/**
 * Login page — email/password with optional SSO.
 *
 * Public signup is NOT supported. Only existing recruiter accounts.
 * SSO buttons are rendered only when VITE_SSO_PROVIDERS is configured.
 * Error messages do not leak account existence (generic "Invalid credentials").
 */

import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Button, Card, Input, Label } from '../components/ui';

function getSsoProviders(): string[] {
  const raw = import.meta.env.VITE_SSO_PROVIDERS;
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
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
      // Generic message — never leak account existence
      setError('Invalid credentials. Please check your email and password.');
    }
  }

  async function handleSSO(provider: string) {
    setError(null);
    try {
      await signInWithSSO(provider);
    } catch {
      setError('SSO sign-in is not available. Check configuration.');
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <Card className="w-full max-w-sm p-8">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-accent-600 text-lg font-bold text-white">
            M
          </div>
          <h1 className="text-lg font-semibold text-gray-900">Maya Screen</h1>
          <p className="mt-1 text-sm text-gray-500">Recruiter sign-in</p>
        </div>

        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div>
            <Label htmlFor="login-email">Email</Label>
            <Input
              id="login-email"
              type="email"
              autoComplete="email"
              placeholder="recruiter@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
              required
              aria-required="true"
            />
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

        {ssoProviders.length > 0 && (
          <>
            <div className="my-4 flex items-center gap-3">
              <span className="h-px flex-1 bg-gray-200" />
              <span className="text-xs text-gray-400">or continue with</span>
              <span className="h-px flex-1 bg-gray-200" />
            </div>

            <div className="flex flex-col gap-2">
              {ssoProviders.map((provider) => (
                <Button
                  key={provider}
                  variant="secondary"
                  onClick={() => handleSSO(provider)}
                  disabled={submitting}
                  className="w-full capitalize"
                >
                  {provider === 'google'
                    ? 'Google'
                    : provider === 'github'
                      ? 'GitHub'
                      : provider === 'microsoft'
                        ? 'Microsoft'
                        : provider === 'azure'
                          ? 'Azure AD'
                          : provider.charAt(0).toUpperCase() + provider.slice(1)}
                </Button>
              ))}
            </div>
          </>
        )}

        <p className="mt-6 text-center text-xs text-gray-400">
          Authorised recruiters only. Sign-up is not available.
        </p>
      </Card>
    </div>
  );
}
