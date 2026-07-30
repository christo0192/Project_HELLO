/**
 * MFA Challenge page.
 *
 * Shown to AAL1 users who have verified TOTP factors already enrolled.
 * Presents a code input field. On successful verification, the session
 * is upgraded to AAL2 and the user is redirected to the dashboard.
 *
 * Recovery/error states do not leak account existence — messages are
 * generic ("Invalid code. Please try again.").
 */
import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Button, Card, Input, Label, Spinner } from '../components/ui';

export function MfaChallengePage() {
  const { needsMfa, isAuthenticated, isLoading, challengeMfa, refreshSession } = useAuth();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="h-8 w-8 text-accent-500" />
      </div>
    );
  }

  if (isAuthenticated) {
    return <Navigate to="/candidates" replace />;
  }

  // No session at all — redirect to login
  if (!needsMfa) {
    return <Navigate to="/login" replace />;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!code.trim() || code.length < 6) {
      setError('Please enter the 6-digit code from your authenticator app.');
      return;
    }

    setBusy(true);
    const result = await challengeMfa(code.trim());
    setBusy(false);

    if (result.error || !result.verified) {
      // Generic — do not leak whether the factor exists or credentials
      setError('Invalid code. Please try again.');
      return;
    }

    await refreshSession();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <Card className="w-full max-w-sm p-8">
        <h1 className="mb-2 text-lg font-semibold text-gray-900">
          Two-factor authentication
        </h1>
        <p className="mb-6 text-sm text-gray-500">
          Enter the 6-digit code from your authenticator app.
        </p>

        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div>
            <Label htmlFor="mfa-challenge-code">Authentication code</Label>
            <Input
              id="mfa-challenge-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              maxLength={6}
              value={code}
              onChange={(e) =>
                setCode(e.target.value.replace(/\D/g, '').slice(0, 6))
              }
              disabled={busy}
              required
              aria-required="true"
            />
          </div>

          {error && (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          )}

          <Button type="submit" className="w-full" loading={busy}>
            {busy ? 'Verifying…' : 'Verify'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
