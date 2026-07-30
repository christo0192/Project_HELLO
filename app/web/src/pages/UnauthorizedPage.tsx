/**
 * 403 Forbidden / Unauthorized page.
 *
 * Shown when a recruiter does not have permission to access a resource.
 * Stable UI — does not reveal account details or attempt recovery.
 */
import { Button } from '../components/ui';

export function UnauthorizedPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-gray-300">403</h1>
        <p className="mt-2 text-lg font-semibold text-gray-900">
          Access denied
        </p>
        <p className="mt-1 text-sm text-gray-500">
          You do not have permission to access this resource.
        </p>
        <Button
          variant="secondary"
          className="mt-6"
          onClick={() => (window.location.href = '/login')}
        >
          Return to sign-in
        </Button>
      </div>
    </div>
  );
}
