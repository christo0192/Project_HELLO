/**
 * Route guard that requires an authenticated session and a resolved role.
 *
 * - No session → redirect to /login, carrying an allowlisted return-to in
 *   router state (never a query parameter) so a deep-linked scoped review
 *   survives the sign-in round trip. Any non-allowlisted path is dropped.
 * - Session, role still resolving → loading state (never children)
 * - Session, role resolved null (denied / stale session / API failure)
 *   → redirect to /unauthorized (fail closed)
 * - Session + resolved role → render children
 *
 * ADR-0011: single factor — no MFA/AAL2 requirement. The API is always
 * authoritative: it enforces an ACTIVE server-held allowlist entry plus the
 * role on every request. This guard is UX only and must never be treated as
 * the security boundary.
 *
 * Renders no recruiter/candidate data before the role resolves, so a user
 * whose allowlist entry was revoked never sees data flash before denial.
 */

import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth, type MembershipRole } from '../lib/auth';
import { sanitizeReturnTo } from '../lib/return-to';
import { Spinner } from './ui';

interface ProtectedRouteProps {
  /**
   * Optional role gate (UX only — APIs remain authoritative). When set:
   *   - role unresolved / /api/me failed → fail closed (never render content)
   *   - role mismatch → redirect to /unauthorized
   */
  requireRole?: MembershipRole;
}

export function ProtectedRoute({ requireRole }: ProtectedRouteProps = {}) {
  const { isLoading, isAuthenticated, role, isRoleLoading } = useAuth();
  const location = useLocation();

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

  // No session at all — redirect to login. The return-to is validated against
  // an exact path allowlist BEFORE it is handed to the login page, and travels
  // in router state only, so no attacker-supplied destination can ride along.
  if (!isAuthenticated) {
    const returnTo = sanitizeReturnTo(location.pathname);
    return (
      <Navigate
        to="/login"
        replace
        state={returnTo ? { returnTo } : undefined}
      />
    );
  }

  // Role still resolving — never render children speculatively. This applies
  // to EVERY protected route, not just role-gated ones, so no recruiter or
  // candidate data can flash before authorization is known.
  if (isRoleLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Spinner className="h-8 w-8 text-accent-500" />
          <p className="text-sm text-gray-500">Checking access…</p>
        </div>
      </div>
    );
  }

  // Role resolved to null — /api/me denied or failed (revoked allowlist
  // entry, inactive account, stale session). Fail closed.
  if (role === null) {
    return <Navigate to="/unauthorized" replace />;
  }

  // Phase 9 L4 (invariant 5): role gate. A resolved mismatch redirects
  // unauthorized. The API re-checks the role on every request regardless.
  if (requireRole && role !== requireRole) {
    return <Navigate to="/unauthorized" replace />;
  }

  // Authenticated with a resolved, sufficient role — render children
  return <Outlet />;
}
