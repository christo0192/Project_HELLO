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
import { GlassPanel, buttonClass } from '../components/design';

export function NotFoundPage() {
  return (
    <div className="app-ground flex min-h-screen items-center justify-center px-4 py-10">
      <main className="w-full max-w-md">
        <GlassPanel level="strong" padding="lg" className="text-center">
          <div className="flex justify-center">
            <Brand />
          </div>
          <p className="mt-6 text-stat text-ink-tertiary">404</p>
          <h1 className="mt-1 text-[15px] font-semibold tracking-[-0.01em] text-ink">
            Page not found
          </h1>
          <p className="mt-1.5 text-[13px] leading-5 text-ink-tertiary">
            The page you're looking for doesn't exist or has moved.
          </p>
          <div className="mt-6 flex flex-col gap-2">
            <Link to="/dashboard" className={buttonClass('primary', 'lg', 'w-full')}>
              Go to Dashboard
            </Link>
            <Link to="/login" className={buttonClass('secondary', 'lg', 'w-full')}>
              Back to sign-in
            </Link>
          </div>
        </GlassPanel>
      </main>
    </div>
  );
}
