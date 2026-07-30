/**
 * Route guard that requires an authenticated AAL2 session.
 *
 * - No session → redirect to /login
 * - AAL1 session → redirect to /mfa/enroll or /mfa/challenge
 * - AAL2 session → render children (recruiter dashboard content)
 *
 * Renders no recruiter/candidate data before an authenticated
 * AAL2 session is confirmed.  Loading state shown during check.
 */

import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Spinner } from './ui';

export function ProtectedRoute() {
  const { isLoading, isAuthenticated, needsMfa, factors } = useAuth();

  // Still checking session — no data rendered
  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Spinner className="h-8 w-8 text-accent-500" />
          <p className="text-sm text-gray-500">Checking session…</p>
        </div>
      </div>
    );
  }

  // No session at all — redirect to login
  if (!isAuthenticated && !needsMfa) {
    return <Navigate to="/login" replace />;
  }

  // Session exists but only AAL1 (needs MFA)
  if (needsMfa) {
    // Has verified TOTP factors → challenge
    if (factors.length > 0) {
      return <Navigate to="/mfa/challenge" replace />;
    }
    // No verified factors → enroll
    return <Navigate to="/mfa/enroll" replace />;
  }

  // Fully authenticated at AAL2 — render children
  return <Outlet />;
}
