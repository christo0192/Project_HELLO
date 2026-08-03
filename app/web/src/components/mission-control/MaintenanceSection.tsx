/**
 * Mission Control — Maintenance (service state + confirmed toggle).
 *
 * Data: GET /api/status (current state) and POST /api/admin/maintenance
 * (atomic toggle + audit reason). The toggle is explicitly confirmed, and
 * success is never optimistic: the message renders only after the API
 * responds, and the state is re-read from the response and refreshed.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../api';
import type { PublicStatus } from '../../types';
import { StatusBadge } from '../design';
import { ErrorState, LoadingState } from '../ui';
import { ConfirmButton } from './ConfirmButton';
import { maintenanceMeta, stableMutationMessage } from './statusMeta';

export function MaintenanceSection() {
  const [status, setStatus] = useState<PublicStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [enabled, setEnabled] = useState(false);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    api
      .status()
      .then((next) => {
        setStatus(next);
        setEnabled(next.maintenance?.enabled === true);
        setReason(next.maintenance?.reason ?? '');
      })
      .catch((e: ApiError) => setLoadError(e.message));
  }, []);

  useEffect(load, [load]);

  if (loadError && !status) {
    return <ErrorState message={loadError} onRetry={load} />;
  }
  if (!status) {
    return <LoadingState label="Loading maintenance state…" />;
  }

  const meta = maintenanceMeta(status);

  async function applyToggle() {
    setMessage(null);
    try {
      const res = await api.toggleMaintenance({
        enabled,
        reason: reason.trim(),
      });
      setMessage({
        text: `Maintenance is now ${res.enabled ? 'enabled' : 'disabled'}.`,
        tone: 'ok',
      });
      // Response-confirmed: re-read current state after the mutation.
      const next = await api.status();
      setStatus(next);
      setEnabled(next.maintenance?.enabled === true);
      setReason(next.maintenance?.reason ?? '');
    } catch (e) {
      setMessage({
        text: stableMutationMessage(
          e instanceof ApiError ? e.message : null,
          'Failed to change maintenance mode.',
        ),
        tone: 'error',
      });
    }
  }

  const canSubmit = reason.trim().length > 0;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Maintenance</h2>
          <p className="mt-0.5 text-xs text-ink-tertiary">
            When enabled, new screening sessions are blocked. Changes are
            confirmed and audited with a reason.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          className="inline-flex items-center rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink-secondary transition-colors hover:bg-surface-tertiary hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-info"
        >
          Refresh
        </button>
      </div>

      {message && (
        <p
          role="status"
          className={`mb-4 rounded-lg border px-3 py-2 text-sm ${
            message.tone === 'ok'
              ? 'border-success/30 bg-success-soft text-success'
              : 'border-error/30 bg-error-soft text-error'
          }`}
        >
          {message.text}
        </p>
      )}

      <div className="rounded-xl border border-line bg-surface p-5 shadow-card">
        <h3 className="text-sm font-semibold text-ink">Current state</h3>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
          <p className="text-sm text-ink-secondary">{meta.detail}</p>
        </div>
        <p className="mt-2 text-xs text-ink-tertiary">
          Status updated {formatUpdatedAt(status.updated_at)} · last change{' '}
          {formatUpdatedAt(status.maintenance?.updated_at)}
        </p>
      </div>

      <div className="mt-6 rounded-xl border border-line bg-surface p-5 shadow-card">
        <h3 className="text-sm font-semibold text-ink">Change maintenance mode</h3>
        <p className="mt-0.5 text-xs text-ink-tertiary">
          A reason is required for both enabling and disabling — it is
          written to the audit log.
        </p>

        <label className="mt-4 flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-line-strong text-brand-600 focus:ring-brand-500"
          />
          Enable maintenance (block new sessions)
        </label>

        <div className="mt-4">
          <label htmlFor="maintenance-reason" className="mb-1 block text-xs font-medium text-ink-secondary">
            Reason (required)
          </label>
          <input
            id="maintenance-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={200}
            placeholder="e.g. planned deployment window"
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-tertiary focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
        </div>

        <div className="mt-4">
          <ConfirmButton
            label="Apply change"
            confirmLabel="Confirm change"
            variant={enabled ? 'primary' : 'secondary'}
            disabled={!canSubmit}
            summary={
              <span>
                {enabled ? 'Enable' : 'Disable'} maintenance mode? Reason: “
                {reason.trim() || '—'}”. New screening sessions will be{' '}
                {enabled ? 'blocked' : 'allowed'}.
              </span>
            }
            onConfirm={applyToggle}
          />
        </div>
      </div>
    </div>
  );
}

function formatUpdatedAt(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}
