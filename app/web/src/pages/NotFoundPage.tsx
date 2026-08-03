/**
 * NotFoundPage — public 404 for unknown routes.
 *
 * Replaces the previous silent redirect-to-login for public catch-all
 * paths with a truthful, branded page. Protected unknown paths redirect
 * to the dashboard inside Layout (server-side ProtectedRoute enforcement
 * remains the source of truth).
 */

import { Link } from 'react-router-dom';
import { Brand } from '../components/navigation';

export function NotFoundPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-surface px-4">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-8 text-center shadow-card">
        <div className="mb-5 flex justify-center">
          <Brand />
        </div>
        <p className="text-sm font-semibold uppercase tracking-wider text-brand-600 dark:text-brand-300">
          404
        </p>
        <h1 className="mt-1 text-lg font-semibold text-ink">
          Page not found
        </h1>
        <p className="mt-2 text-sm text-ink-secondary">
          The page you're looking for doesn't exist or has moved.
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <Link
            to="/dashboard"
            className="inline-flex items-center justify-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
          >
            Go to Dashboard
          </Link>
          <Link
            to="/login"
            className="inline-flex items-center justify-center rounded-lg border border-line bg-surface px-4 py-2 text-sm font-medium text-ink-secondary transition-colors hover:bg-surface-tertiary hover:text-ink"
          >
            Back to sign-in
          </Link>
        </div>
      </div>
    </div>
  );
}
