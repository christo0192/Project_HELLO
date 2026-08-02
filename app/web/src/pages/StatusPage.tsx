import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { PublicStatus } from '../types';
import { Card } from '../components/ui';

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

  const tone =
    status?.status === 'ok'
      ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
      : status?.status === 'maintenance'
        ? 'bg-amber-50 text-amber-800 border-amber-200'
        : 'bg-red-50 text-red-800 border-red-200';

  return (
    <main className="mx-auto flex min-h-screen max-w-xl items-center px-4">
      <Card className="w-full p-6">
        <h1 className="text-xl font-semibold text-gray-900">Service status</h1>
        <p className="mt-1 text-sm text-gray-500">
          Current operational status of the screening service.
        </p>

        {!status && !error && (
          <p className="mt-4 text-sm text-gray-500" role="status">
            Checking…
          </p>
        )}

        {error && (
          <p className="mt-4 text-sm text-red-600" role="alert">
            {error}
          </p>
        )}

        {status && (
          <div className={`mt-4 rounded-md border p-4 ${tone}`} role="status">
            <p className="text-sm font-semibold">
              {status.status === 'ok'
                ? 'All systems operational'
                : status.status === 'maintenance'
                  ? 'Scheduled maintenance'
                  : 'Service degraded'}
            </p>
            {status.status === 'maintenance' && status.maintenance?.reason && (
              <p className="mt-1 text-sm">{status.maintenance.reason}</p>
            )}
            <p className="mt-2 text-xs text-gray-500">
              Updated {new Date(status.updated_at).toLocaleString()}
            </p>
          </div>
        )}
      </Card>
    </main>
  );
}
