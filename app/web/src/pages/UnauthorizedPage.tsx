/**
 * 403 Forbidden / Unauthorized page.
 *
 * Shown when a recruiter does not have permission to access a resource.
 * Stable UI — does not reveal account details or attempt recovery.
 */
import { Brand } from '../components/navigation';
import { Button, GlassPanel } from '../components/design';

export function UnauthorizedPage() {
  return (
    <div className="app-ground flex min-h-screen items-center justify-center px-4 py-10">
      <main className="w-full max-w-md">
        <GlassPanel level="strong" padding="lg" className="text-center">
          <div className="flex justify-center">
            <Brand />
          </div>
          <p className="mt-6 text-stat text-ink-tertiary">403</p>
          <h1 className="mt-1 text-[15px] font-semibold tracking-[-0.01em] text-ink">
            Access denied
          </h1>
          <p className="mt-1.5 text-[13px] leading-5 text-ink-tertiary">
            You do not have permission to access this resource.
          </p>
          <Button
            variant="primary"
            size="lg"
            className="mt-6 w-full"
            onClick={() => (window.location.href = '/login')}
          >
            Return to sign-in
          </Button>
        </GlassPanel>
      </main>
    </div>
  );
}
