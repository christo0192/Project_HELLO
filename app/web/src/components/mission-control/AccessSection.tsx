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
import { plainErrorText } from '../../lib/api-error-copy';
import { COMPANY_EMAIL_DOMAINS_LABEL, isCompanyEmail } from '../../lib/auth';
import type {
  AdminAllowlistEntry,
  MeResponse,
  MembershipRole,
} from '../../types';
import {
  Button,
  Combobox,
  EmptyPanel,
  ErrorPanel,
  Field,
  GlassPanel,
  InlineNotice,
  LoadingPanel,
  Pagination,
  SectionHeader,
  SegmentedControl,
  StatusBadge,
  Switch,
  Table,
  TBody,
  Td,
  TextField,
  Th,
  THead,
  Tr,
  usePagination,
} from '../design';
import { ConfirmButton } from './ConfirmButton';
import {
  allowlistEntryState,
  allowlistStateLabel,
  allowlistStateTone,
  countLinkedActiveAdmins,
  handoverSummary,
  isSelfEntry,
  normalizeEmailPreview,
  stableMutationMessage,
} from './statusMeta';
import type { AllowlistEntryState } from './statusMeta';

type FilterValue = 'all' | AllowlistEntryState;

/** The stored role word stays the value; a person reads the label. */
const ROLE_OPTIONS: Array<{ value: MembershipRole; label: string }> = [
  { value: 'viewer', label: 'Viewer' },
  { value: 'interviewer', label: 'Interviewer' },
  { value: 'admin', label: 'Admin' },
];

const FILTERS: Array<{ value: FilterValue; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'linked', label: 'Linked' },
  { value: 'pending', label: 'Pending' },
  { value: 'disabled', label: 'Disabled' },
];

function roleLabel(role: MembershipRole): string {
  return ROLE_OPTIONS.find((option) => option.value === role)?.label ?? role;
}

export function AccessSection() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [entries, setEntries] = useState<AdminAllowlistEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [filter, setFilter] = useState<FilterValue>('all');
  const [drafts, setDrafts] = useState<
    Record<string, { role: MembershipRole; active: boolean }>
  >({});

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
      .catch((e: ApiError) => setLoadError(`The access list couldn't load. ${plainErrorText(e.message)}`));
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

  const filtered = useMemo(
    () =>
      (entries ?? []).filter((entry) => {
        if (filter === 'all') return true;
        return allowlistEntryState(entry) === filter;
      }),
    [entries, filter],
  );

  const page = usePagination(filtered, 10, filter);

  if (loadError && !entries) {
    return <ErrorPanel message={loadError} onRetry={load} />;
  }
  if (!entries || !me) {
    return <LoadingPanel label="Loading access list…" />;
  }

  function setDraft(
    id: string,
    patch: Partial<{ role: MembershipRole; active: boolean }>,
  ) {
    setDrafts((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? { role: 'viewer', active: true }), ...patch },
    }));
  }

  async function addEntry(email: string, role: MembershipRole): Promise<boolean> {
    setMessage(null);
    try {
      await api.addAdminAllowlistEntry({ email: email.trim(), role });
      setMessage({ text: 'Access entry added.', tone: 'ok' });
      await refreshEntries();
      return true;
    } catch (e) {
      setMessage({
        text: stableMutationMessage(
          e instanceof ApiError ? e.message : null,
          'Failed to add the access entry.',
        ),
        tone: 'error',
      });
      return false;
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

  async function handoverRecords(
    from: AdminAllowlistEntry,
    to: AdminAllowlistEntry,
  ): Promise<boolean> {
    setMessage(null);
    try {
      const result = await api.handoverAdminAllowlistRecords(from.id, { to_entry_id: to.id });
      setMessage({ text: handoverSummary(result.moved, to.email), tone: 'ok' });
      return true;
    } catch (e) {
      setMessage({
        text: stableMutationMessage(
          e instanceof ApiError ? e.message : null,
          'The records could not be handed over. Try again.',
        ),
        tone: 'error',
      });
      // A refusal like to_inactive / from_not_linked means the list changed
      // under us — resync so the pickers reflect server truth.
      await refreshEntries();
      return false;
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

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Access entries"
        description="Pre-login company emails become linked once the person signs in — server-side normalization is authoritative."
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

      {/* Add entry — its own component so typing re-renders the form, not
          the whole entry table (keeps keystrokes cheap on long allowlists). */}
      <AddEntryForm onAdd={addEntry} />

      <SegmentedControl
        ariaLabel="Filter access entries"
        value={filter}
        onChange={setFilter}
        options={FILTERS.map((f) => ({
          value: f.value,
          label: f.label,
          count: counts[f.value],
        }))}
      />

      {filtered.length === 0 ? (
        <EmptyPanel
          title={`No ${filter === 'all' ? '' : `${filter} `}access entries`}
          hint={
            entries.length === 0
              ? 'Add an email above to start the allowlist.'
              : 'Try another filter.'
          }
        />
      ) : (
        <div>
          <Table bare flush caption="Access list — email, role, active, state and actions">
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
              {page.items.map((entry) => {
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
                  changes.push(`role ${roleLabel(entry.role)} → ${roleLabel(draft.role)}`);
                }
                if (draft && draft.active !== entry.active) {
                  changes.push(`active ${entry.active ? 'yes' : 'no'} → ${draft.active ? 'yes' : 'no'}`);
                }
                return (
                  <Tr key={entry.id}>
                    <Td>
                      <span className="font-medium text-ink">{entry.email}</span>
                      {locked && (
                        <p className="mt-0.5 max-w-xs text-xs leading-5 text-warning-text">
                          {selfEntry
                            ? 'Your own entry — self-modification is protected.'
                            : 'Last linked active admin — cannot be removed or demoted.'}
                        </p>
                      )}
                    </Td>
                    <Td>
                      {/* In flow, not floating: the table's scroller would clip a
                          floating list, and three short names need no search. */}
                      <Combobox
                        id={`access-role-${entry.id}`}
                        aria-label={`Role for ${entry.email}`}
                        size="sm"
                        searchable={false}
                        value={draft?.role ?? entry.role}
                        disabled={locked}
                        onChange={(value) => setDraft(entry.id, { role: value as MembershipRole })}
                        options={ROLE_OPTIONS}
                        placeholder="Role"
                        searchLabel={`Role for ${entry.email}`}
                        listLabel="Roles"
                        className="w-36 min-w-[9rem]"
                      />
                    </Td>
                    <Td>
                      <Switch
                        size="sm"
                        aria-label={`Active for ${entry.email}`}
                        checked={draft?.active ?? entry.active}
                        disabled={locked}
                        onCheckedChange={(next) =>
                          setDraft(entry.id, { active: next })
                        }
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
                        triggerSize="sm"
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
          <Pagination state={page} noun="entries" />
        </div>
      )}

      <HandoverPanel entries={entries} onHandover={handoverRecords} />

      <p className="text-label leading-5 text-ink-tertiary">
        You can't change your own entry, or remove or demote the last linked active
        admin, so nobody can lock the workspace out.
      </p>
    </div>
  );
}

/**
 * The add-entry form owns its draft state. `onAdd` resolves true when the
 * server accepted the entry, which clears the form; the parent owns the
 * feedback message and the list refresh.
 */
function AddEntryForm({
  onAdd,
}: {
  onAdd: (email: string, role: MembershipRole) => Promise<boolean>;
}) {
  const [email, setEmail] = useState('');
  const [newRole, setNewRole] = useState<MembershipRole>('viewer');
  const normalizedPreview = normalizeEmailPreview(email);
  const hasNormalization = email !== normalizedPreview && normalizedPreview.length > 0;
  const notCompany = email.trim().length > 0 && !isCompanyEmail(email);

  async function submit() {
    const ok = await onAdd(email, newRole);
    if (ok) {
      setEmail('');
      setNewRole('viewer');
    }
  }

  return (
    <GlassPanel level="ruled">
      <SectionHeader
        level={3}
        title="Add an access entry"
        description="The person does not need an account yet — this grants pre-login access to the workspace."
      />
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_auto] sm:items-start">
        <Field label="Company email" id="access-email">
          {({ id }) => (
            <>
              <TextField
                id={id}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@dexity.com"
                autoComplete="off"
              />
              {notCompany && (
                <p className="text-xs leading-5 text-warning-text" role="note">
                  Only {COMPANY_EMAIL_DOMAINS_LABEL} emails can be added.
                </p>
              )}
              {hasNormalization && !notCompany && (
                <p className="text-xs leading-5 text-ink-tertiary" role="note">
                  Will be stored as {normalizedPreview}
                </p>
              )}
            </>
          )}
        </Field>
        <Field label="Role" id="access-role">
          {({ id, labelId }) => (
            <Combobox
              id={id}
              labelId={labelId}
              size="md"
              searchable={false}
              value={newRole}
              onChange={(value) => setNewRole(value as MembershipRole)}
              options={ROLE_OPTIONS}
              placeholder="Role"
              searchLabel="Role"
              listLabel="Roles"
            />
          )}
        </Field>
        <ConfirmButton
          className="sm:pt-[1.375rem]"
          label="Add entry"
          confirmLabel="Add access entry"
          disabled={email.trim().length === 0}
          summary={
            <span>
              Add <strong>{email.trim() || 'this email'}</strong> as a{' '}
              <strong>{roleLabel(newRole)}</strong>? The person can sign in before
              creating an account.
            </span>
          }
          onConfirm={submit}
        />
      </div>
    </GlassPanel>
  );
}

/**
 * Hand a person's records to their new login (0133). Only needed when
 * someone returns on the new company domain as a BRAND-NEW login; a renamed
 * login keeps everything automatically. Both sides must have signed in at
 * least once (the server needs both login ids) and the target must be
 * active — the server re-checks all of it and maps refusals to stable copy.
 */
function HandoverPanel({
  entries,
  onHandover,
}: {
  entries: AdminAllowlistEntry[];
  onHandover: (from: AdminAllowlistEntry, to: AdminAllowlistEntry) => Promise<boolean>;
}) {
  // Collapsed by default: a once-per-person action that should not crowd the
  // everyday access table (and keeps emails out of the page until asked for).
  const [open, setOpen] = useState(false);
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');

  const sources = entries.filter((entry) => entry.linked_user_id != null);
  const targets = entries.filter(
    (entry) => entry.linked_user_id != null && entry.active && entry.id !== fromId,
  );
  const from = sources.find((entry) => entry.id === fromId) ?? null;
  const to = targets.find((entry) => entry.id === toId) ?? null;

  async function submit() {
    if (!from || !to) return;
    const ok = await onHandover(from, to);
    if (ok) {
      setFromId('');
      setToId('');
      setOpen(false);
    }
  }

  function close() {
    setFromId('');
    setToId('');
    setOpen(false);
  }

  return (
    <GlassPanel level="ruled">
      <SectionHeader
        level={3}
        title="Hand over a person's records"
        description="For someone who now signs in with a brand-new login (for example a fresh @dexity.com account). Moves the roles, candidates, calls, R1 rounds, Ashby jobs and finished drafts they own. If their login was only renamed, they keep everything automatically and nothing needs moving."
        actions={
          open ? (
            <Button size="sm" onClick={close}>
              Cancel
            </Button>
          ) : (
            <Button size="sm" onClick={() => setOpen(true)}>
              Start a handover
            </Button>
          )
        }
      />
      {open && (
        <>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-start">
            <Field label="From (old login)" id="handover-from">
              {({ id, labelId }) => (
                <Combobox
                  id={id}
                  labelId={labelId}
                  size="md"
                  value={fromId}
                  onChange={(value) => {
                    setFromId(value);
                    if (value === toId) setToId('');
                  }}
                  options={sources.map((entry) => ({
                    value: entry.id,
                    label: `${entry.email}${entry.active ? '' : ' (disabled)'}`,
                  }))}
                  placeholder="Choose a person"
                  searchLabel="Search people"
                  listLabel="People"
                  noun={['person', 'people']}
                />
              )}
            </Field>
            <Field label="To (new login)" id="handover-to">
              {({ id, labelId }) => (
                <Combobox
                  id={id}
                  labelId={labelId}
                  size="md"
                  value={toId}
                  onChange={setToId}
                  options={targets.map((entry) => ({ value: entry.id, label: entry.email }))}
                  placeholder="Choose a person"
                  searchLabel="Search people"
                  listLabel="People"
                  noun={['person', 'people']}
                />
              )}
            </Field>
            <ConfirmButton
              className="sm:pt-[1.375rem]"
              label="Hand over"
              confirmLabel="Hand over records"
              variant="secondary"
              disabled={!from || !to}
              summary={
                <span>
                  Move the roles, candidates, calls, R1 rounds, Ashby jobs and finished drafts{' '}
                  <strong>{from?.email ?? 'this person'}</strong> owns to{' '}
                  <strong>{to?.email ?? 'the new login'}</strong>? The audit log of who did what is
                  not changed. Afterwards, disable the old entry.
                </span>
              }
              onConfirm={submit}
            />
          </div>
          <p className="mt-3 text-xs leading-5 text-ink-tertiary">
            Only people who have signed in at least once appear here. Ask the new login to sign in
            once first.
          </p>
        </>
      )}
    </GlassPanel>
  );
}
