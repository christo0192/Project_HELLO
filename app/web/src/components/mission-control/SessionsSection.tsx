/**
 * Mission Control — Sessions (bounded admin session view + override).
 *
 * Data: GET /api/admin/sessions (optional status filter) and the bounded
 * override POST /api/admin/sessions/:id/override (target status + required
 * reason). Updates are response-confirmed — the list refreshes and the
 * message renders only after the API responds. Sessions in a terminal
 * state (failed/cancelled/expired/deleted) are immutable: the override
 * form is locked for them and no resurrection transition is offered.
 *
 * Layout: a paginated glass table on the left, a sticky override inspector
 * on the right. The row radios and the inspector's session select are two
 * views of the same `selectedId`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import type { AdminSessionRow } from '../../types';
import {
  Button,
  EmptyPanel,
  ErrorPanel,
  GlassPanel,
  InlineNotice,
  LoadingPanel,
  Pagination,
  RevealGroup,
  RevealItem,
  SectionHeader,
  SelectField,
  StatusBadge,
  TBody,
  THead,
  Table,
  Td,
  TextField,
  Th,
  Tr,
  usePagination,
} from '../design';
import { ConfirmButton } from './ConfirmButton';
import { sessionStatusLabel, sessionStatusTone } from '../talent';
import {
  OVERRIDE_TARGET_STATUSES,
  SESSION_FILTER_STATUSES,
  formatDateTime,
  isTerminalSessionStatus,
  shortId,
  stableMutationMessage,
} from './statusMeta';

/** Stable empty reference so `usePagination` doesn't re-slice every render. */
const NO_SESSIONS: AdminSessionRow[] = [];

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

  // The admin list is bounded at 50 rows on this surface; pagination pages
  // through that bound rather than widening it.
  const bounded = useMemo(
    () => (sessions ? sessions.slice(0, 50) : NO_SESSIONS),
    [sessions],
  );
  const paged = usePagination(bounded, 10);

  if (loadError && !sessions) {
    return <ErrorPanel message={loadError} onRetry={() => load()} />;
  }
  if (!sessions) {
    return <LoadingPanel label="Loading sessions…" />;
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
    <div className="space-y-5">
      <SectionHeader
        level={2}
        title="Sessions"
        meta={
          <span className="text-[13px] tabular-nums text-ink-tertiary">
            {sessions.length} total · {terminalCount} terminal
          </span>
        }
        description="Opaque identifiers only — no candidate PII. Terminal sessions are immutable."
        actions={
          <Button size="sm" variant="secondary" onClick={() => load()}>
            Refresh
          </Button>
        }
      />

      {message && (
        <InlineNotice role="status" tone={message.tone === 'ok' ? 'success' : 'danger'}>
          {message.text}
        </InlineNotice>
      )}

      <div className="flex flex-wrap items-center gap-2.5">
        <label htmlFor="session-filter" className="text-[13px] font-medium text-ink-secondary">
          Status filter
        </label>
        <div className="w-56">
          <SelectField
            id="session-filter"
            size="sm"
            value={filter}
            onChange={(e) => changeFilter(e.target.value)}
          >
            <option value="all">All statuses</option>
            {SESSION_FILTER_STATUSES.map((status) => (
              <option key={status} value={status}>
                {sessionStatusLabel(status)}
              </option>
            ))}
          </SelectField>
        </div>
      </div>

      <RevealGroup className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <RevealItem className="min-w-0">
          {sessions.length === 0 ? (
            <EmptyPanel
              title="No sessions found"
              hint={
                filter === 'all'
                  ? 'No sessions have been created yet.'
                  : 'No sessions match this status filter.'
              }
            />
          ) : (
            <>
              <Table caption="Admin session list — id, status, candidate, created, started, ended">
                <THead>
                  <Tr>
                    <Th className="w-10">
                      <span className="sr-only">Select</span>
                    </Th>
                    <Th>ID</Th>
                    <Th>Status</Th>
                    <Th>Candidate</Th>
                    <Th>Created</Th>
                    <Th>Started</Th>
                    <Th>Ended</Th>
                  </Tr>
                </THead>
                <TBody>
                  {paged.items.map((session) => (
                    <Tr
                      key={session.id}
                      className={session.id === selectedId ? 'bg-info-soft' : undefined}
                    >
                      <Td className="pr-0">
                        <input
                          type="radio"
                          name="override-session"
                          value={session.id}
                          checked={session.id === selectedId}
                          onChange={() => setSelectedId(session.id)}
                          aria-label={`Select session ${shortId(session.id)}`}
                          className="h-4 w-4 cursor-pointer accent-info"
                        />
                      </Td>
                      <Td className="whitespace-nowrap font-mono text-xs text-ink-secondary">
                        {shortId(session.id)}
                      </Td>
                      <Td>
                        <StatusBadge tone={sessionStatusTone(session.status)}>
                          {sessionStatusLabel(session.status)}
                        </StatusBadge>
                      </Td>
                      <Td className="whitespace-nowrap font-mono text-xs text-ink-secondary">
                        {shortId(session.candidate_id)}
                      </Td>
                      <Td className="whitespace-nowrap tabular-nums text-ink-secondary">
                        {formatDateTime(session.created_at)}
                      </Td>
                      <Td className="whitespace-nowrap tabular-nums text-ink-secondary">
                        {formatDateTime(session.started_at)}
                      </Td>
                      <Td className="whitespace-nowrap tabular-nums text-ink-secondary">
                        {formatDateTime(session.ended_at)}
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
              <Pagination state={paged} noun="sessions" />
            </>
          )}
        </RevealItem>

        <RevealItem>
          <GlassPanel className="lg:sticky lg:top-20">
            <SectionHeader
              level={3}
              title="Override session status"
              description="Bounded CAS override with a required audit reason — terminal states (failed, cancelled, expired, deleted) cannot be changed, so no resurrection is offered."
            />

            {sessions.length === 0 ? (
              <p className="mt-4 text-sm text-ink-tertiary">Nothing to override yet.</p>
            ) : (
              <div className="mt-4 space-y-3.5">
                {selected && (
                  <div className="glass-sunken flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                    <span className="font-mono text-xs text-ink-secondary">
                      {shortId(selected.id)}
                    </span>
                    <StatusBadge tone={sessionStatusTone(selected.status)}>
                      {sessionStatusLabel(selected.status)}
                    </StatusBadge>
                  </div>
                )}

                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="override-session"
                    className="text-[13px] font-medium text-ink-secondary"
                  >
                    Session
                  </label>
                  <SelectField
                    id="override-session"
                    value={selectedId}
                    disabled={terminal}
                    onChange={(e) => setSelectedId(e.target.value)}
                  >
                    {bounded.map((session) => (
                      <option key={session.id} value={session.id}>
                        {shortId(session.id)} — {session.status}
                        {isTerminalSessionStatus(session.status)
                          ? ' (terminal — locked)'
                          : ''}
                      </option>
                    ))}
                  </SelectField>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="override-target"
                    className="text-[13px] font-medium text-ink-secondary"
                  >
                    Target status
                  </label>
                  <SelectField
                    id="override-target"
                    value={targetStatus}
                    disabled={terminal}
                    onChange={(e) =>
                      setTargetStatus(
                        e.target.value as (typeof OVERRIDE_TARGET_STATUSES)[number],
                      )
                    }
                  >
                    {OVERRIDE_TARGET_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {status}
                      </option>
                    ))}
                  </SelectField>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="override-reason"
                    className="text-[13px] font-medium text-ink-secondary"
                  >
                    Reason (required)
                  </label>
                  <TextField
                    id="override-reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    maxLength={200}
                    placeholder="Audit reason…"
                    disabled={terminal}
                  />
                </div>

                {terminal && selected ? (
                  <InlineNotice tone="warning">
                    This session is in a terminal state (
                    {sessionStatusLabel(selected.status)}) and cannot be changed.
                  </InlineNotice>
                ) : (
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
                )}
              </div>
            )}
          </GlassPanel>
        </RevealItem>
      </RevealGroup>
    </div>
  );
}
