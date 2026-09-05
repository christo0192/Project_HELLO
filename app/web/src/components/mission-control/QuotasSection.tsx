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
import {
  Button,
  EmptyPanel,
  ErrorPanel,
  Field,
  GlassPanel,
  InlineNotice,
  LoadingPanel,
  Pagination,
  RevealGroup,
  RevealItem,
  SectionHeader,
  SelectField,
  StatusBadge,
  Switch,
  TextField,
  usePagination,
} from '../design';
import { ConfirmButton } from './ConfirmButton';
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

/** Row pills — the same limit facts as the summary, one per fact. */
function policyLimits(policy: QuotaPolicy): string[] {
  return [
    `Max sessions ${policy.max_sessions ?? '∞'}`,
    `Cost units ${policy.max_cost_units ?? '∞'}`,
    `${policy.cost_units_per_session ?? '—'} units/session`,
    policy.warning_percentage == null
      ? 'Warning off'
      : `Warn at ${policy.warning_percentage}%`,
    `${policy.period_days}-day period`,
  ];
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

  const page = usePagination(policies ?? [], 10);

  if (loadError && !policies) {
    return <ErrorPanel message={loadError} onRetry={load} />;
  }
  if (!policies) {
    return <LoadingPanel label="Loading quota policies…" />;
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
    <div className="space-y-5">
      <SectionHeader
        title="Quota policies"
        description="Abstract cost units only — never currency or provider price; policies are disabled by default and enforcement engages only once enabled."
        meta={
          <span className="text-[13px] tabular-nums text-ink-tertiary">
            {enabledCount} of {policies.length} enabled
          </span>
        }
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

      {policies.length === 0 ? (
        <EmptyPanel
          title="No quota policies configured"
          hint="Quota enforcement is off. Create a policy below to set limits."
        />
      ) : (
        <div>
          <RevealGroup className="space-y-3">
            {page.items.map((policy) => (
              <RevealItem key={policy.id}>
                <GlassPanel padding="sm" data-policy-row={policy.id}>
                  <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-ink">
                        {policy.scope === 'global' ? 'Global' : 'Candidate'}
                      </p>
                      {policy.scope === 'candidate' && (
                        <p className="font-mono text-xs text-ink-tertiary">
                          {shortId(policy.scope_id)}
                        </p>
                      )}
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {policyLimits(policy).map((limit) => (
                          <span
                            key={limit}
                            className="rounded-full bg-ink/[0.05] px-2 py-0.5 text-xs text-ink-secondary"
                          >
                            {limit}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="shrink-0">
                      <StatusBadge tone={policy.enabled ? 'success' : 'neutral'}>
                        {policy.enabled ? 'enabled' : 'disabled'}
                      </StatusBadge>
                      <p className="mt-1 text-xs text-ink-tertiary">
                        updated {formatDateTime(policy.updated_at)}
                      </p>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-start gap-2">
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
                        <Button size="sm" onClick={() => startEdit(policy)}>
                          Edit
                        </Button>
                      )}
                    </div>
                  </div>

                  {editId === policy.id && (
                    <EditForm
                      policy={policy}
                      edit={edits[policy.id] ?? EMPTY_DRAFT}
                      onChange={(key, value) => setEditField(policy.id, key, value)}
                      onCancel={() => setEditId(null)}
                    />
                  )}
                </GlassPanel>
              </RevealItem>
            ))}
          </RevealGroup>
          <Pagination state={page} noun="policies" />
        </div>
      )}

      {/* Create */}
      <GlassPanel>
        <SectionHeader
          level={3}
          title="Create policy"
          description="Blank limits mean unlimited — the confirmation below shows the exact scope before anything is created."
        />
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Scope" id="quota-scope">
            {({ id }) => (
              <SelectField
                id={id}
                value={draft.scope}
                onChange={(e) =>
                  setDraftField('scope', e.target.value as CreateDraft['scope'])
                }
              >
                <option value="global">Global — all sessions</option>
                <option value="candidate">Candidate — one person</option>
              </SelectField>
            )}
          </Field>
          {draft.scope === 'candidate' && (
            <Field label="Candidate ID" id="quota-scope-id">
              {({ id }) => (
                <TextField
                  id={id}
                  value={draft.scopeId}
                  onChange={(e) => setDraftField('scopeId', e.target.value)}
                  placeholder="UUID"
                />
              )}
            </Field>
          )}
          <Field label="Max sessions (blank = unlimited)" id="quota-max-sessions">
            {({ id }) => (
              <TextField
                id={id}
                type="number"
                min={1}
                value={draft.maxSessions}
                onChange={(e) => setDraftField('maxSessions', e.target.value)}
              />
            )}
          </Field>
          <Field label="Max cost units (abstract)" id="quota-max-cost">
            {({ id }) => (
              <TextField
                id={id}
                type="number"
                min={1}
                value={draft.maxCostUnits}
                onChange={(e) => setDraftField('maxCostUnits', e.target.value)}
              />
            )}
          </Field>
          <Field label="Cost units per session (abstract)" id="quota-units-session">
            {({ id }) => (
              <TextField
                id={id}
                type="number"
                min={1}
                value={draft.costPerSession}
                onChange={(e) => setDraftField('costPerSession', e.target.value)}
              />
            )}
          </Field>
          <Field label="Warning % (blank = off)" id="quota-warning">
            {({ id }) => (
              <TextField
                id={id}
                type="number"
                min={1}
                max={100}
                value={draft.warningPct}
                onChange={(e) => setDraftField('warningPct', e.target.value)}
              />
            )}
          </Field>
        </div>

        <div className="glass-sunken mt-4 rounded-[14px] p-4">
          <Switch
            checked={draft.enabled}
            onCheckedChange={(next) => setDraftField('enabled', next)}
            label="Enabled"
          />
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
      </GlassPanel>
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
    <div className="glass-sunken mt-3 rounded-[14px] p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Max sessions">
          {({ id }) => (
            <TextField
              id={id}
              size="sm"
              type="number"
              min={1}
              value={edit.maxSessions}
              onChange={(e) => onChange('maxSessions', e.target.value)}
              aria-label={`Max sessions for ${policy.id}`}
            />
          )}
        </Field>
        <Field label="Max cost units">
          {({ id }) => (
            <TextField
              id={id}
              size="sm"
              type="number"
              min={1}
              value={edit.maxCostUnits}
              onChange={(e) => onChange('maxCostUnits', e.target.value)}
              aria-label={`Max cost units for ${policy.id}`}
            />
          )}
        </Field>
        <Field label="Units / session">
          {({ id }) => (
            <TextField
              id={id}
              size="sm"
              type="number"
              min={1}
              value={edit.costPerSession}
              onChange={(e) => onChange('costPerSession', e.target.value)}
              aria-label={`Cost units per session for ${policy.id}`}
            />
          )}
        </Field>
        <Field label="Warning %">
          {({ id }) => (
            <TextField
              id={id}
              size="sm"
              type="number"
              min={1}
              max={100}
              value={edit.warningPct}
              onChange={(e) => onChange('warningPct', e.target.value)}
              aria-label={`Warning percentage for ${policy.id}`}
            />
          )}
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <Switch
          size="sm"
          checked={edit.enabled}
          onCheckedChange={(next) => onChange('enabled', next)}
          aria-label={`Enabled for ${policy.id}`}
        />
        <Button size="sm" onClick={onCancel}>
          Cancel edit
        </Button>
      </div>
    </div>
  );
}
