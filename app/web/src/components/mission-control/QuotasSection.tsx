/**
 * Mission Control — Quotas (abstract quota policy configuration).
 *
 * Writable ONLY through the audited quota API (GET/POST
 * /api/admin/quotas, PATCH /api/admin/quotas/:id). Cost units are
 * ABSTRACT integers — never currency or provider price — and policies are
 * disabled by default (enforcement engages only when enabled). Every
 * create/update/toggle is confirmed explicitly, and the confirmation
 * summarises the exact scope before anything is sent.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../api';
import type { QuotaPolicy } from '../../types';
import { StatusBadge } from '../design';
import { Table, THead, TBody, Tr, Th, Td } from '../design';
import { ErrorState, LoadingState } from '../ui';
import { ConfirmButton, LinkAction } from './ConfirmButton';
import { buttonClassNames } from './buttonStyles';
import { formatDateTime, shortId, stableMutationMessage } from './statusMeta';

interface CreateDraft {
  scope: 'global' | 'candidate';
  scopeId: string;
  maxSessions: string;
  maxCostUnits: string;
  costPerSession: string;
  warningPct: string;
  enabled: boolean;
}

const EMPTY_DRAFT: CreateDraft = {
  scope: 'global',
  scopeId: '',
  maxSessions: '',
  maxCostUnits: '',
  costPerSession: '',
  warningPct: '',
  enabled: false,
};

function policySummary(policy: QuotaPolicy): string {
  const scope =
    policy.scope === 'global'
      ? 'global — applies to all sessions'
      : `candidate — ${shortId(policy.scope_id)}`;
  return [
    scope,
    `max sessions ${policy.max_sessions ?? '∞'}`,
    `max cost units ${policy.max_cost_units ?? '∞'}`,
    `units/session ${policy.cost_units_per_session ?? '—'}`,
    `warning ${policy.warning_percentage == null ? 'off' : `${policy.warning_percentage}%`}`,
    `period ${policy.period_days}d`,
  ].join(' · ');
}

export function QuotasSection() {
  const [policies, setPolicies] = useState<QuotaPolicy[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [draft, setDraft] = useState<CreateDraft>(EMPTY_DRAFT);
  const [editId, setEditId] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, CreateDraft>>({});

  const [message, setMessage] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    setPolicies(null);
    api
      .listAdminQuotas()
      .then((r) => setPolicies(r.policies))
      .catch((e: ApiError) => setLoadError(e.message));
  }, []);

  useEffect(load, [load]);

  if (loadError && !policies) {
    return <ErrorState message={loadError} onRetry={load} />;
  }
  if (!policies) {
    return <LoadingState label="Loading quota policies…" />;
  }

  function setDraftField<K extends keyof CreateDraft>(
    key: K,
    value: CreateDraft[K],
  ) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function createPolicy() {
    setMessage(null);
    try {
      await api.createQuotaPolicy({
        scope: draft.scope,
        scope_id: draft.scope === 'candidate' ? draft.scopeId || null : null,
        max_sessions: draft.maxSessions === '' ? null : Number(draft.maxSessions),
        max_cost_units:
          draft.maxCostUnits === '' ? null : Number(draft.maxCostUnits),
        cost_units_per_session:
          draft.costPerSession === '' ? null : Number(draft.costPerSession),
        warning_percentage:
          draft.warningPct === '' ? null : Number(draft.warningPct),
        enabled: draft.enabled,
      });
      setDraft(EMPTY_DRAFT);
      setMessage({
        text: 'Quota policy created (disabled by default unless enabled).',
        tone: 'ok',
      });
      await load();
    } catch (e) {
      setMessage({
        text: stableMutationMessage(
          e instanceof ApiError ? e.message : null,
          'Failed to create the quota policy.',
        ),
        tone: 'error',
      });
    }
  }

  async function togglePolicy(policy: QuotaPolicy) {
    setMessage(null);
    try {
      await api.updateQuotaPolicy(policy.id, {
        scope: policy.scope,
        scope_id: policy.scope_id,
        mode: policy.mode,
        max_sessions: policy.max_sessions,
        max_cost_units: policy.max_cost_units,
        cost_units_per_session: policy.cost_units_per_session,
        warning_percentage: policy.warning_percentage,
        period_days: policy.period_days,
        enabled: !policy.enabled,
      });
      setMessage({
        text: `Policy ${policy.enabled ? 'disabled' : 'enabled'}.`,
        tone: 'ok',
      });
      await load();
    } catch (e) {
      setMessage({
        text: stableMutationMessage(
          e instanceof ApiError ? e.message : null,
          'Failed to update the quota policy.',
        ),
        tone: 'error',
      });
    }
  }

  async function saveEdit(policy: QuotaPolicy) {
    const edit = edits[policy.id];
    if (!edit) return;
    setMessage(null);
    try {
      await api.updateQuotaPolicy(policy.id, {
        scope: policy.scope,
        scope_id: policy.scope_id,
        mode: policy.mode,
        max_sessions: edit.maxSessions === '' ? null : Number(edit.maxSessions),
        max_cost_units:
          edit.maxCostUnits === '' ? null : Number(edit.maxCostUnits),
        cost_units_per_session:
          edit.costPerSession === '' ? null : Number(edit.costPerSession),
        warning_percentage:
          edit.warningPct === '' ? null : Number(edit.warningPct),
        period_days: policy.period_days,
        enabled: edit.enabled,
      });
      setEditId(null);
      setMessage({ text: 'Quota policy updated.', tone: 'ok' });
      await load();
    } catch (e) {
      setMessage({
        text: stableMutationMessage(
          e instanceof ApiError ? e.message : null,
          'Failed to update the quota policy.',
        ),
        tone: 'error',
      });
    }
  }

  function startEdit(policy: QuotaPolicy) {
    setEditId(policy.id);
    setEdits((prev) => ({
      ...prev,
      [policy.id]: {
        scope: policy.scope,
        scopeId: policy.scope_id ?? '',
        maxSessions: policy.max_sessions == null ? '' : String(policy.max_sessions),
        maxCostUnits:
          policy.max_cost_units == null ? '' : String(policy.max_cost_units),
        costPerSession:
          policy.cost_units_per_session == null
            ? ''
            : String(policy.cost_units_per_session),
        warningPct:
          policy.warning_percentage == null
            ? ''
            : String(policy.warning_percentage),
        enabled: policy.enabled,
      },
    }));
  }

  function setEditField(id: string, key: keyof CreateDraft, value: string | boolean) {
    setEdits((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? EMPTY_DRAFT), [key]: value },
    }));
  }

  const enabledCount = policies.filter((p) => p.enabled).length;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Quota policies</h2>
          <p className="mt-0.5 text-xs text-ink-tertiary">
            Abstract cost units only — never currency or provider price.
            Policies are disabled by default; enforcement engages only once
            enabled. {enabledCount} of {policies.length} currently enabled.
          </p>
        </div>
        <LinkAction onClick={load}>Refresh</LinkAction>
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

      {policies.length === 0 ? (
        <div className="mb-6 rounded-xl border border-dashed border-line-strong bg-surface-secondary p-10 text-center">
          <p className="text-sm font-medium text-ink-secondary">
            No quota policies configured
          </p>
          <p className="mt-1 text-xs text-ink-tertiary">
            Quota enforcement is off. Create a policy below to set limits.
          </p>
        </div>
      ) : (
        <Table caption="Quota policies — scope, limits, state and actions">
          <THead>
            <Tr>
              <Th>Scope</Th>
              <Th>Limits</Th>
              <Th>State</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </Tr>
          </THead>
          <TBody>
            {policies.map((policy) => (
              <Tr key={policy.id}>
                <Td>
                  <p className="font-medium text-ink">
                    {policy.scope === 'global' ? 'Global' : 'Candidate'}
                  </p>
                  {policy.scope === 'candidate' && (
                    <p className="font-mono text-xs text-ink-tertiary">
                      {shortId(policy.scope_id)}
                    </p>
                  )}
                </Td>
                <Td>
                  {editId === policy.id ? (
                    <EditForm
                      policy={policy}
                      edit={edits[policy.id] ?? EMPTY_DRAFT}
                      onChange={(key, value) =>
                        setEditField(policy.id, key, value)
                      }
                      onCancel={() => setEditId(null)}
                    />
                  ) : (
                    <p className="text-xs text-ink-secondary">
                      {policySummary(policy)}
                    </p>
                  )}
                </Td>
                <Td>
                  <StatusBadge tone={policy.enabled ? 'success' : 'neutral'}>
                    {policy.enabled ? 'enabled' : 'disabled'}
                  </StatusBadge>
                  <p className="mt-0.5 text-xs text-ink-tertiary">
                    updated {formatDateTime(policy.updated_at)}
                  </p>
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-2">
                    <ConfirmButton
                      label={policy.enabled ? 'Disable' : 'Enable'}
                      variant="secondary"
                      confirmLabel={`Confirm ${policy.enabled ? 'disable' : 'enable'}`}
                      summary={
                        <span>
                          {policy.enabled ? 'Disable' : 'Enable'} the{' '}
                          <strong>{policy.scope}</strong> quota policy (
                          {policySummary(policy)})?
                        </span>
                      }
                      onConfirm={() => togglePolicy(policy)}
                    />
                    {editId === policy.id ? (
                      <ConfirmButton
                        label="Save changes"
                        variant="primary"
                        confirmLabel="Confirm update"
                        summary={
                          <span>
                            Update the <strong>{policy.scope}</strong> policy
                            with the limits shown above?
                          </span>
                        }
                        onConfirm={() => saveEdit(policy)}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => startEdit(policy)}
                        className={buttonClassNames('secondary', 'px-2.5 py-1.5 text-xs')}
                      >
                        Edit
                      </button>
                    )}
                  </div>
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}

      {/* Create */}
      <div className="mt-6 rounded-xl border border-line bg-surface p-5 shadow-card">
        <h3 className="text-sm font-semibold text-ink">Create policy</h3>
        <p className="mt-0.5 text-xs text-ink-tertiary">
          Blank limits mean unlimited. The confirmation below shows the exact
          scope before anything is created.
        </p>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="quota-scope" className="mb-1 block text-xs font-medium text-ink-secondary">
              Scope
            </label>
            <select
              id="quota-scope"
              value={draft.scope}
              onChange={(e) =>
                setDraftField(
                  'scope',
                  e.target.value as CreateDraft['scope'],
                )
              }
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            >
              <option value="global">Global — all sessions</option>
              <option value="candidate">Candidate — one person</option>
            </select>
          </div>
          {draft.scope === 'candidate' && (
            <div>
              <label htmlFor="quota-scope-id" className="mb-1 block text-xs font-medium text-ink-secondary">
                Candidate ID
              </label>
              <input
                id="quota-scope-id"
                value={draft.scopeId}
                onChange={(e) => setDraftField('scopeId', e.target.value)}
                placeholder="UUID"
                className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-tertiary focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>
          )}
          <div>
            <label htmlFor="quota-max-sessions" className="mb-1 block text-xs font-medium text-ink-secondary">
              Max sessions (blank = unlimited)
            </label>
            <input
              id="quota-max-sessions"
              type="number"
              min={1}
              value={draft.maxSessions}
              onChange={(e) => setDraftField('maxSessions', e.target.value)}
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
          <div>
            <label htmlFor="quota-max-cost" className="mb-1 block text-xs font-medium text-ink-secondary">
              Max cost units (abstract)
            </label>
            <input
              id="quota-max-cost"
              type="number"
              min={1}
              value={draft.maxCostUnits}
              onChange={(e) => setDraftField('maxCostUnits', e.target.value)}
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
          <div>
            <label htmlFor="quota-units-session" className="mb-1 block text-xs font-medium text-ink-secondary">
              Cost units per session (abstract)
            </label>
            <input
              id="quota-units-session"
              type="number"
              min={1}
              value={draft.costPerSession}
              onChange={(e) => setDraftField('costPerSession', e.target.value)}
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
          <div>
            <label htmlFor="quota-warning" className="mb-1 block text-xs font-medium text-ink-secondary">
              Warning % (blank = off)
            </label>
            <input
              id="quota-warning"
              type="number"
              min={1}
              max={100}
              value={draft.warningPct}
              onChange={(e) => setDraftField('warningPct', e.target.value)}
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
          <label className="flex items-center gap-2 pt-5 text-sm text-ink">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => setDraftField('enabled', e.target.checked)}
              className="h-4 w-4 rounded border-line-strong text-brand-600 focus:ring-brand-500"
            />
            Enabled
          </label>
        </div>
        <div className="mt-4">
          <ConfirmButton
            label="Create policy"
            confirmLabel="Confirm create"
            summary={
              <span>
                Create a <strong>{draft.scope}</strong> policy
                {draft.scope === 'candidate' && draft.scopeId
                  ? ` for candidate ${shortId(draft.scopeId)}`
                  : ''}{' '}
                with max sessions {draft.maxSessions || '∞'}, max cost units{' '}
                {draft.maxCostUnits || '∞'}, units/session{' '}
                {draft.costPerSession || '—'}, warning{' '}
                {draft.warningPct ? `${draft.warningPct}%` : 'off'} —{' '}
                {draft.enabled ? 'enabled' : 'disabled'}?
              </span>
            }
            onConfirm={createPolicy}
          />
        </div>
      </div>
    </div>
  );
}

function EditForm({
  policy,
  edit,
  onChange,
  onCancel,
}: {
  policy: QuotaPolicy;
  edit: CreateDraft;
  onChange: (key: keyof CreateDraft, value: string | boolean) => void;
  onCancel: () => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <label className="text-xs text-ink-secondary">
        Max sessions
        <input
          type="number"
          min={1}
          value={edit.maxSessions}
          onChange={(e) => onChange('maxSessions', e.target.value)}
          aria-label={`Max sessions for ${policy.id}`}
          className="mt-1 w-full rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
      </label>
      <label className="text-xs text-ink-secondary">
        Max cost units
        <input
          type="number"
          min={1}
          value={edit.maxCostUnits}
          onChange={(e) => onChange('maxCostUnits', e.target.value)}
          aria-label={`Max cost units for ${policy.id}`}
          className="mt-1 w-full rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
      </label>
      <label className="text-xs text-ink-secondary">
        Units / session
        <input
          type="number"
          min={1}
          value={edit.costPerSession}
          onChange={(e) => onChange('costPerSession', e.target.value)}
          aria-label={`Cost units per session for ${policy.id}`}
          className="mt-1 w-full rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
      </label>
      <label className="text-xs text-ink-secondary">
        Warning %
        <input
          type="number"
          min={1}
          max={100}
          value={edit.warningPct}
          onChange={(e) => onChange('warningPct', e.target.value)}
          aria-label={`Warning percentage for ${policy.id}`}
          className="mt-1 w-full rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
      </label>
      <label className="col-span-2 flex items-center gap-2 text-xs text-ink">
        <input
          type="checkbox"
          checked={edit.enabled}
          onChange={(e) => onChange('enabled', e.target.checked)}
          aria-label={`Enabled for ${policy.id}`}
          className="h-4 w-4 rounded border-line-strong text-brand-600 focus:ring-brand-500"
        />
        Enabled
      </label>
      <button
        type="button"
        onClick={onCancel}
        className={buttonClassNames('secondary', 'col-span-2 px-2.5 py-1.5 text-xs')}
      >
        Cancel edit
      </button>
    </div>
  );
}
