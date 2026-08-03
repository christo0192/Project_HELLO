/**
 * Mission Control — Sessions (bounded admin session view + override).
 *
 * Data: GET /api/admin/sessions (optional status filter) and the bounded
 * override POST /api/admin/sessions/:id/override (target status + required
 * reason). Updates are response-confirmed — the list refreshes and the
 * message renders only after the API responds. Sessions in a terminal
 * state (failed/cancelled/expired/deleted) are immutable: the override
 * form is locked for them and no resurrection transition is offered.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import type { AdminSessionRow } from '../../types';
import { StatusBadge } from '../design';
import { Table, THead, TBody, Tr, Th, Td } from '../design';
import { ErrorState, LoadingState } from '../ui';
import { ConfirmButton } from './ConfirmButton';
import { buttonClassNames } from './buttonStyles';
import { sessionStatusLabel, sessionStatusTone } from '../talent';
import {
  OVERRIDE_TARGET_STATUSES,
  SESSION_FILTER_STATUSES,
  formatDateTime,
  isTerminalSessionStatus,
  shortId,
  stableMutationMessage,
} from './statusMeta';

export function SessionsSection() {
  const [sessions, setSessions] = useState<AdminSessionRow[] | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState('');
  const [targetStatus, setTargetStatus] =
    useState<(typeof OVERRIDE_TARGET_STATUSES)[number]>('waiting');
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);

  // Keep the current filter in a ref so `load` stays stable (mount-only
  // effect, explicit filter changes via changeFilter).
  const filterRef = useRef(filter);
  filterRef.current = filter;

  const load = useCallback((nextFilter?: string) => {
    const status = nextFilter ?? filterRef.current;
    setLoadError(null);
    setSessions(null);
    api
      .listAdminSessions(status === 'all' ? undefined : status)
      .then((r) => {
        setSessions(r.sessions);
        setSelectedId((prev) =>
          prev && r.sessions.some((s) => s.id === prev)
            ? prev
            : (r.sessions[0]?.id ?? ''),
        );
      })
      .catch((e: ApiError) => setLoadError(e.message));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loadError && !sessions) {
    return <ErrorState message={loadError} onRetry={() => load()} />;
  }
  if (!sessions) {
    return <LoadingState label="Loading sessions…" />;
  }

  const selected = sessions.find((s) => s.id === selectedId) ?? null;
  const terminal = selected ? isTerminalSessionStatus(selected.status) : false;

  async function runOverride() {
    if (!selected || !reason.trim()) return;
    setMessage(null);
    try {
      const res = await api.overrideSession(selected.id, {
        target_status: targetStatus,
        reason: reason.trim(),
      });
      setMessage({
        text:
          res.prior_status != null
            ? `Session updated to ${targetStatus} (was ${res.prior_status}).`
            : `Session updated to ${targetStatus}.`,
        tone: 'ok',
      });
      setReason('');
      await load();
    } catch (e) {
      setMessage({
        text: stableMutationMessage(
          e instanceof ApiError ? e.message : null,
          'Failed to override the session.',
        ),
        tone: 'error',
      });
      await load();
    }
  }

  function changeFilter(next: string) {
    setFilter(next);
    load(next);
  }

  const terminalCount = sessions.filter((s) =>
    isTerminalSessionStatus(s.status),
  ).length;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Sessions</h2>
          <p className="mt-0.5 text-xs text-ink-tertiary">
            Opaque identifiers only — no candidate PII. Terminal sessions
            ({terminalCount} of {sessions.length}) are immutable.
          </p>
        </div>
        <button
          type="button"
          onClick={() => load()}
          className={buttonClassNames('secondary', 'px-3 py-1.5 text-xs')}
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

      {/* Filter */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label htmlFor="session-filter" className="text-xs font-medium text-ink-secondary">
          Status filter
        </label>
        <select
          id="session-filter"
          value={filter}
          onChange={(e) => changeFilter(e.target.value)}
          className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        >
          <option value="all">All statuses</option>
          {SESSION_FILTER_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </div>

      {sessions.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong bg-surface-secondary p-10 text-center">
          <p className="text-sm font-medium text-ink-secondary">No sessions found</p>
          <p className="mt-1 text-xs text-ink-tertiary">
            {filter === 'all'
              ? 'No sessions have been created yet.'
              : 'No sessions match this status filter.'}
          </p>
        </div>
      ) : (
        <Table caption="Admin session list — id, status, candidate, created, started, ended">
          <THead>
            <Tr>
              <Th>ID</Th>
              <Th>Status</Th>
              <Th>Candidate</Th>
              <Th>Created</Th>
              <Th>Started</Th>
              <Th>Ended</Th>
            </Tr>
          </THead>
          <TBody>
            {sessions.slice(0, 50).map((session) => (
              <Tr key={session.id}>
                <Td className="font-mono text-xs text-ink-secondary">
                  {shortId(session.id)}
                </Td>
                <Td>
                  <StatusBadge tone={sessionStatusTone(session.status)}>
                    {sessionStatusLabel(session.status)}
                  </StatusBadge>
                </Td>
                <Td className="font-mono text-xs text-ink-secondary">
                  {shortId(session.candidate_id)}
                </Td>
                <Td className="tabular-nums text-ink-secondary">
                  {formatDateTime(session.created_at)}
                </Td>
                <Td className="tabular-nums text-ink-secondary">
                  {formatDateTime(session.started_at)}
                </Td>
                <Td className="tabular-nums text-ink-secondary">
                  {formatDateTime(session.ended_at)}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}

      {/* Override */}
      <div className="mt-6 rounded-xl border border-line bg-surface p-5 shadow-card">
        <h3 className="text-sm font-semibold text-ink">Override session status</h3>
        <p className="mt-0.5 text-xs text-ink-tertiary">
          Bounded CAS override with a required audit reason. Terminal states
          (failed, cancelled, expired, deleted) cannot be changed — no
          resurrection.
        </p>

        {sessions.length === 0 ? (
          <p className="mt-4 text-sm text-ink-tertiary">
            Nothing to override yet.
          </p>
        ) : (
          <>
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="override-session" className="mb-1 block text-xs font-medium text-ink-secondary">
                  Session
                </label>
                <select
                  id="override-session"
                  value={selectedId}
                  onChange={(e) => setSelectedId(e.target.value)}
                  disabled={terminal}
                  className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:opacity-50"
                >
                  {sessions.slice(0, 50).map((session) => (
                    <option key={session.id} value={session.id}>
                      {shortId(session.id)} — {session.status}
                      {isTerminalSessionStatus(session.status)
                        ? ' (terminal — locked)'
                        : ''}
                    </option>
                  ))}
                </select>
                {selected && (
                  <p className="mt-1.5 text-xs text-ink-tertiary">
                    Current status:{' '}
                    <StatusBadge tone={sessionStatusTone(selected.status)}>
                      {sessionStatusLabel(selected.status)}
                    </StatusBadge>
                  </p>
                )}
              </div>
              <div>
                <label htmlFor="override-target" className="mb-1 block text-xs font-medium text-ink-secondary">
                  Target status
                </label>
                <select
                  id="override-target"
                  value={targetStatus}
                  disabled={terminal}
                  onChange={(e) =>
                    setTargetStatus(
                      e.target.value as (typeof OVERRIDE_TARGET_STATUSES)[number],
                    )
                  }
                  className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:opacity-50"
                >
                  {OVERRIDE_TARGET_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="override-reason" className="mb-1 block text-xs font-medium text-ink-secondary">
                  Reason (required)
                </label>
                <input
                  id="override-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={200}
                  placeholder="Audit reason…"
                  disabled={terminal}
                  className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-tertiary focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:opacity-50"
                />
              </div>
            </div>

            {terminal && selected ? (
              <p className="mt-4 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning">
                This session is in a terminal state (
                {sessionStatusLabel(selected.status)}) and cannot be changed.
              </p>
            ) : (
              <div className="mt-4">
                <ConfirmButton
                  label="Apply override"
                  confirmLabel="Confirm override"
                  disabled={!selected || reason.trim().length === 0}
                  summary={
                    <span>
                      Set session <strong>{selected ? shortId(selected.id) : '—'}</strong>{' '}
                      from <strong>{selected ? sessionStatusLabel(selected.status) : '—'}</strong>{' '}
                      to <strong>{targetStatus}</strong>? Reason: “{reason.trim() || '—'}”.
                    </span>
                  }
                  onConfirm={runOverride}
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
