/**
 * Mission Control — Access (normalized-email allowlist management).
 *
 * Writable ONLY through the Lane-2 audited allowlist API
 * (GET/POST /api/admin/allowlist, PATCH /api/admin/allowlist/:id).
 * The server is authoritative for normalization and safety guards
 * (self-modification and last-linked-active-admin are rejected with 409);
 * the UI surfaces those rules up front so operators never attempt a
 * doomed call, and maps every stable 400/409 code to operator copy.
 *
 * Emails appear only on this management surface (the backend's stated
 * admin surface). They are never rendered in Overview/Audit, never
 * logged, and never sent to any analytics.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../../api';
import { isCompanyEmail } from '../../lib/auth';
import type {
  AdminAllowlistEntry,
  MeResponse,
  MembershipRole,
} from '../../types';
import { StatusBadge } from '../design';
import { Table, THead, TBody, Tr, Th, Td } from '../design';
import { ErrorState, LoadingState } from '../ui';
import { ConfirmButton, LinkAction } from './ConfirmButton';
import { buttonClassNames } from './buttonStyles';
import {
  allowlistEntryState,
  allowlistStateLabel,
  allowlistStateTone,
  countLinkedActiveAdmins,
  isSelfEntry,
  normalizeEmailPreview,
  stableMutationMessage,
} from './statusMeta';
import type { AllowlistEntryState } from './statusMeta';

type FilterValue = 'all' | AllowlistEntryState;

const FILTERS: Array<{ value: FilterValue; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'linked', label: 'Linked' },
  { value: 'pending', label: 'Pending' },
  { value: 'disabled', label: 'Disabled' },
];

export function AccessSection() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [entries, setEntries] = useState<AdminAllowlistEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [filter, setFilter] = useState<FilterValue>('all');
  const [drafts, setDrafts] = useState<
    Record<string, { role: MembershipRole; active: boolean }>
  >({});

  // Add form
  const [email, setEmail] = useState('');
  const [newRole, setNewRole] = useState<MembershipRole>('viewer');

  // Feedback
  const [message, setMessage] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    Promise.all([api.getMe(), api.listAdminAllowlist()])
      .then(([nextMe, list]) => {
        setMe(nextMe);
        setEntries(list.entries);
        setDrafts(
          Object.fromEntries(
            list.entries.map((entry) => [
              entry.id,
              { role: entry.role, active: entry.active },
            ]),
          ),
        );
      })
      .catch((e: ApiError) => setLoadError(e.message));
  }, []);

  useEffect(load, [load]);

  const linkedAdmins = useMemo(
    () => countLinkedActiveAdmins(entries ?? []),
    [entries],
  );

  const counts = useMemo(() => {
    const list = entries ?? [];
    const result: Record<FilterValue, number> = {
      all: list.length,
      linked: 0,
      pending: 0,
      disabled: 0,
    };
    for (const entry of list) {
      result[allowlistEntryState(entry)] += 1;
    }
    return result;
  }, [entries]);

  if (loadError && !entries) {
    return <ErrorState message={loadError} onRetry={load} />;
  }
  if (!entries || !me) {
    return <LoadingState label="Loading access list…" />;
  }

  const normalizedPreview = normalizeEmailPreview(email);
  const hasNormalization = email !== normalizedPreview && normalizedPreview.length > 0;
  const notCompany = email.trim().length > 0 && !isCompanyEmail(email);

  function setDraft(
    id: string,
    patch: Partial<{ role: MembershipRole; active: boolean }>,
  ) {
    setDrafts((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? { role: 'viewer', active: true }), ...patch },
    }));
  }

  async function addEntry() {
    setMessage(null);
    try {
      await api.addAdminAllowlistEntry({ email: email.trim(), role: newRole });
      setEmail('');
      setNewRole('viewer');
      setMessage({ text: 'Access entry added.', tone: 'ok' });
      await refreshEntries();
    } catch (e) {
      setMessage({
        text: stableMutationMessage(
          e instanceof ApiError ? e.message : null,
          'Failed to add the access entry.',
        ),
        tone: 'error',
      });
    }
  }

  async function updateEntry(entry: AdminAllowlistEntry) {
    setMessage(null);
    const draft = drafts[entry.id];
    if (!draft) return;
    const body: { role?: MembershipRole; active?: boolean } = {};
    if (draft.role !== entry.role) body.role = draft.role;
    if (draft.active !== entry.active) body.active = draft.active;
    if (Object.keys(body).length === 0) return;
    try {
      await api.updateAdminAllowlistEntry(entry.id, body);
      setMessage({ text: 'Access entry updated.', tone: 'ok' });
      await refreshEntries();
    } catch (e) {
      // 409 self/last-admin + 404/400 all map to stable copy; resync so the
      // list reflects server truth after a rejected change.
      setMessage({
        text: stableMutationMessage(
          e instanceof ApiError ? e.message : null,
          'Failed to update the access entry.',
        ),
        tone: 'error',
      });
      await refreshEntries();
    }
  }

  async function refreshEntries() {
    try {
      const list = await api.listAdminAllowlist();
      setEntries(list.entries);
      setDrafts(
        Object.fromEntries(
          list.entries.map((entry) => [
            entry.id,
            { role: entry.role, active: entry.active },
          ]),
        ),
      );
    } catch {
      // Keep the last known list; the message above already explains the
      // failure. Never surface a secondary error.
    }
  }

  const filtered = entries.filter((entry) => {
    if (filter === 'all') return true;
    return allowlistEntryState(entry) === filter;
  });


  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Access entries</h2>
          <p className="mt-0.5 text-xs text-ink-tertiary">
            Pre-login company emails — pending entries become linked once the
            person signs in. Server-side normalization is authoritative.
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

      {/* Add entry */}
      <div className="mb-6 rounded-xl border border-line bg-surface p-5 shadow-card">
        <h3 className="text-sm font-semibold text-ink">Add an access entry</h3>
        <p className="mt-0.5 text-xs text-ink-tertiary">
          The person does not need an account yet — this grants pre-login
          access to the workspace.
        </p>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-start">
          <div>
            <label htmlFor="access-email" className="mb-1 block text-xs font-medium text-ink-secondary">
              Company email
            </label>
            <input
              id="access-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@interviewkickstart.com"
              autoComplete="off"
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-tertiary focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            {notCompany && (
              <p className="mt-1.5 text-xs text-warning" role="note">
                Only @interviewkickstart.com emails can be added.
              </p>
            )}
            {hasNormalization && !notCompany && (
              <p className="mt-1.5 text-xs text-ink-tertiary" role="note">
                Will be stored as {normalizedPreview}
              </p>
            )}
          </div>
          <div>
            <label htmlFor="access-role" className="mb-1 block text-xs font-medium text-ink-secondary">
              Role
            </label>
            <select
              id="access-role"
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as MembershipRole)}
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            >
              <option value="viewer">viewer</option>
              <option value="interviewer">interviewer</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <div className="sm:pt-6">
            <ConfirmButton
              label="Add entry"
              confirmLabel="Add access entry"
              disabled={email.trim().length === 0}
              summary={
                <span>
                  Add <strong>{email.trim() || 'this email'}</strong> as a{' '}
                  <strong>{newRole}</strong>? The person can sign in before
                  creating an account.
                </span>
              }
              onConfirm={addEntry}
            />
          </div>
        </div>
      </div>

      {/* Filter */}
      <div role="group" aria-label="Filter access entries" className="mb-3 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            aria-pressed={filter === f.value}
            onClick={() => setFilter(f.value)}
            className={buttonClassNames(
              filter === f.value ? 'primary' : 'secondary',
              'px-3 py-1.5 text-xs',
            )}
          >
            {f.label}
            <span className="ml-1 tabular-nums opacity-70">{counts[f.value]}</span>
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong bg-surface-secondary p-10 text-center">
          <p className="text-sm font-medium text-ink-secondary">
            No {filter === 'all' ? '' : `${filter} `}access entries
          </p>
          <p className="mt-1 text-xs text-ink-tertiary">
            {entries.length === 0
              ? 'Add an email above to start the allowlist.'
              : 'Try another filter.'}
          </p>
        </div>
      ) : (
        <Table caption="Access list — email, role, active, state and actions">
          <THead>
            <Tr>
              <Th>Email</Th>
              <Th>Role</Th>
              <Th>Active</Th>
              <Th>State</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </Tr>
          </THead>
          <TBody>
            {filtered.map((entry) => {
              const draft = drafts[entry.id];
              const state = allowlistEntryState(entry);
              const selfEntry = isSelfEntry(entry.email, me.email);
              const lastLinkedAdmin =
                linkedAdmins === 1 &&
                entry.active &&
                entry.linked_user_id != null &&
                entry.role === 'admin';
              const locked = selfEntry || lastLinkedAdmin;
              const dirty =
                draft != null &&
                (draft.role !== entry.role || draft.active !== entry.active);
              const changes: string[] = [];
              if (draft && draft.role !== entry.role) {
                changes.push(`role ${entry.role} → ${draft.role}`);
              }
              if (draft && draft.active !== entry.active) {
                changes.push(`active ${entry.active ? 'yes' : 'no'} → ${draft.active ? 'yes' : 'no'}`);
              }
              return (
                <Tr key={entry.id}>
                  <Td>
                    <span className="font-medium text-ink">{entry.email}</span>
                    {locked && (
                      <p className="mt-0.5 max-w-xs text-xs text-warning">
                        {selfEntry
                          ? 'Your own entry — self-modification is protected.'
                          : 'Last linked active admin — cannot be removed or demoted.'}
                      </p>
                    )}
                  </Td>
                  <Td>
                    <select
                      aria-label={`Role for ${entry.email}`}
                      value={draft?.role ?? entry.role}
                      disabled={locked}
                      onChange={(e) =>
                        setDraft(entry.id, {
                          role: e.target.value as MembershipRole,
                        })
                      }
                      className="rounded-lg border border-line bg-surface px-2 py-1 text-sm text-ink focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:opacity-50"
                    >
                      <option value="viewer">viewer</option>
                      <option value="interviewer">interviewer</option>
                      <option value="admin">admin</option>
                    </select>
                  </Td>
                  <Td>
                    <input
                      type="checkbox"
                      aria-label={`Active for ${entry.email}`}
                      checked={draft?.active ?? entry.active}
                      disabled={locked}
                      onChange={(e) =>
                        setDraft(entry.id, { active: e.target.checked })
                      }
                      className="h-4 w-4 rounded border-line-strong text-brand-600 focus:ring-brand-500 disabled:opacity-50"
                    />
                  </Td>
                  <Td>
                    <StatusBadge tone={allowlistStateTone(state)}>
                      {allowlistStateLabel(state)}
                    </StatusBadge>
                    {state === 'linked' && entry.linked_at && (
                      <p className="mt-0.5 text-xs text-ink-tertiary">
                        linked {new Date(entry.linked_at).toLocaleDateString()}
                      </p>
                    )}
                  </Td>
                  <Td>
                    <ConfirmButton
                      label="Save"
                      confirmLabel="Confirm change"
                      variant="secondary"
                      disabled={locked || !dirty}
                      summary={
                        <span>
                          Update <strong>{entry.email}</strong> —{' '}
                          {changes.length > 0 ? changes.join(', ') : 'no change'}?
                        </span>
                      }
                      onConfirm={() => updateEntry(entry)}
                    />
                  </Td>
                </Tr>
              );
            })}
          </TBody>
        </Table>
      )}

      <p className="mt-3 text-xs text-ink-tertiary">
        Self-modification and removal of the last linked active admin are
        rejected by the server (409) — this surface never attempts to bypass
        those guards.
      </p>
    </div>
  );
}
