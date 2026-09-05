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
import {
  Button,
  ErrorPanel,
  Field,
  GlassPanel,
  InlineNotice,
  LoadingPanel,
  SectionHeader,
  StatusBadge,
  Switch,
  TextField,
} from '../design';
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
    return <ErrorPanel message={loadError} onRetry={load} />;
  }
  if (!status) {
    return <LoadingPanel label="Loading maintenance state…" />;
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
    <div className="space-y-5">
      <SectionHeader
        title="Maintenance"
        description="When enabled, new screening sessions are blocked — every change is confirmed and audited with a reason."
        actions={
          <Button size="sm" onClick={load}>
            Refresh
          </Button>
        }
      />

      {message && (
        <InlineNotice tone={message.tone === 'ok' ? 'success' : 'danger'} role="status">
          {message.text}
        </InlineNotice>
      )}

      <GlassPanel>
        <SectionHeader level={3} title="Current state" />
        <div className="glass-sunken mt-3 flex flex-wrap items-center gap-3 rounded-[14px] p-4">
          <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
          <p className="text-sm text-ink-secondary">{meta.detail}</p>
        </div>
        <p className="mt-3 text-[13px] text-ink-tertiary">
          Status updated {formatUpdatedAt(status.updated_at)} · last change{' '}
          {formatUpdatedAt(status.maintenance?.updated_at)}
        </p>
      </GlassPanel>

      <GlassPanel>
        <SectionHeader
          level={3}
          title="Change maintenance mode"
          description="A reason is required for both enabling and disabling — it is written to the audit log."
        />

        <div className="glass-sunken mt-4 rounded-[14px] p-4">
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            label="Enable maintenance (block new sessions)"
          />
        </div>

        <Field label="Reason (required)" id="maintenance-reason" className="mt-4">
          {({ id }) => (
            <TextField
              id={id}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={200}
              placeholder="e.g. planned deployment window"
            />
          )}
        </Field>

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
      </GlassPanel>
    </div>
  );
}

function formatUpdatedAt(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}
