/**
 * MFA Enrollment page.
 *
 * Shown to AAL1 users who have no verified TOTP factors.
 * Displays the TOTP secret/URI so the recruiter can set up their
 * authenticator app, then verifies a code to upgrade to AAL2.
 */
import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Button, Card, Input, Label, Spinner } from '../components/ui';

export function MfaEnrollPage() {
  const { needsMfa, isAuthenticated, isLoading, enrollMfa, challengeMfa, factors, refreshSession } =
    useAuth();
  const [step, setStep] = useState<'idle' | 'enrolled' | 'verifying'>('idle');
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // If auth check not done yet
  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="h-8 w-8 text-accent-500" />
      </div>
    );
  }

  // Already authenticated at AAL2
  if (isAuthenticated) {
    return <Navigate to="/candidates" replace />;
  }

  // Not in MFA-needed state — no session at all, redirect to login
  if (!needsMfa) {
    return <Navigate to="/login" replace />;
  }

  // Already has verified factors — skip enrollment, go to challenge
  if (factors.length > 0 && step === 'idle') {
    return <Navigate to="/mfa/challenge" replace />;
  }

  async function handleEnroll() {
    setError(null);
    setBusy(true);
    const result = await enrollMfa();
    setBusy(false);
    if (result.error) {
      setError('Failed to set up MFA. Please try again.');
      return;
    }
    setTotpUri(result.totpUri ?? null);
    setSecret(result.secret ?? null);
    setStep('enrolled');
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!code.trim()) {
      setError('Please enter the 6-digit code from your authenticator app.');
      return;
    }
    setBusy(true);
    const result = await challengeMfa(code.trim());
    setBusy(false);
    if (result.error || !result.verified) {
      setError('Invalid code. Please try again.');
      return;
    }
    await refreshSession();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <Card className="w-full max-w-md p-8">
        <h1 className="mb-2 text-lg font-semibold text-gray-900">
          Two-factor authentication
        </h1>
        <p className="mb-6 text-sm text-gray-500">
          Secure your account with a time-based one-time password (TOTP)
          authenticator app.
        </p>

        {step === 'idle' && (
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              You need to set up multi-factor authentication before accessing
              the recruiter dashboard.
            </p>
            <Button onClick={handleEnroll} loading={busy} className="w-full">
              Set up authenticator app
            </Button>
            {error && (
              <p className="text-sm text-red-600" role="alert">
                {error}
              </p>
            )}
          </div>
        )}

        {step === 'enrolled' && (
          <div className="space-y-4">
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
              <p className="mb-2 text-sm font-medium text-gray-700">
                Setup key
              </p>
              {secret ? (
                <code className="block break-all rounded bg-white px-3 py-2 text-sm font-mono text-gray-800 select-all">
                  {secret}
                </code>
              ) : totpUri ? (
                <code className="block break-all rounded bg-white px-3 py-2 text-sm font-mono text-gray-800 select-all">
                  {totpUri}
                </code>
              ) : (
                <p className="text-sm text-gray-500">
                  Check your authenticator app for the setup prompt.
                </p>
              )}
            </div>

            <p className="text-sm text-gray-600">
              Open your authenticator app (Google Authenticator, Authy, 1Password,
              etc.) and add a new account using the setup key above, or scan the
              QR code if available. Then enter the 6-digit code below.
            </p>

            <form onSubmit={handleVerify} noValidate className="space-y-4">
              <div>
                <Label htmlFor="mfa-enroll-code">Verification code</Label>
                <Input
                  id="mfa-enroll-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="000000"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
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
                Verify & continue
              </Button>
            </form>
          </div>
        )}
      </Card>
    </div>
  );
}
