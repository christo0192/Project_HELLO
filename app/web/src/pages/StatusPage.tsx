import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { PublicStatus } from '../types';
import { GlassPanel, InlineNotice, StatusBadge } from '../components/design';
import type { StatusTone } from '../components/design';

/**
 * Phase 9 L4 — public StatusPage backed by the minimized GET /api/status.
 * No model/provider/internal dependency display and no fake alert/provider
 * sync — the page renders exactly what the bounded endpoint reports.
 */
export function StatusPage() {
  const [status, setStatus] = useState<PublicStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .status()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch((e: ApiError) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const tone: StatusTone =
    status?.status === 'ok'
      ? 'success'
      : status?.status === 'maintenance'
        ? 'warning'
        : 'danger';

  const headline =
    status?.status === 'ok'
      ? 'All systems operational'
      : status?.status === 'maintenance'
        ? 'Scheduled maintenance'
        : 'Service degraded';

  return (
    <div className="app-ground flex min-h-screen items-center justify-center px-4 py-10">
      <main className="w-full max-w-md">
        <GlassPanel level="strong" padding="lg">
          <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">
            Service status
          </h1>
          <p className="mt-0.5 text-[13px] leading-5 text-ink-tertiary">
            Current operational status of the screening service.
          </p>

          {!status && !error && (
            <p className="mt-5 text-sm text-ink-tertiary" role="status">
              Checking…
            </p>
          )}

          {error && (
            <InlineNotice tone="danger" role="alert" className="mt-5">
              {error}
            </InlineNotice>
          )}

          {status && (
            <div role="status" className="glass-sunken mt-5 rounded-[14px] px-4 py-4">
              <StatusBadge tone={tone} className="px-2.5 py-1">
                {headline}
              </StatusBadge>
              {status.status === 'maintenance' && status.maintenance?.reason && (
                <p className="mt-2.5 text-sm leading-6 text-ink-secondary">
                  {status.maintenance.reason}
                </p>
              )}
              <p className="mt-2.5 text-xs text-ink-tertiary">
                Updated {new Date(status.updated_at).toLocaleString()}
              </p>
            </div>
          )}
        </GlassPanel>
      </main>
    </div>
  );
}
