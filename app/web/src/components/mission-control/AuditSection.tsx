/**
 * Mission Control — Audit (bounded, redacted audit view).
 *
 * Data: GET /api/admin/audit?limit&offset — the backend returns ONLY
 * allowlisted fields (id, action, actor_type, actor_id, target_type,
 * target_id, result, created_at). This surface renders exactly those
 * fields and nothing else: metadata, IPs, correlation IDs, tokens and
 * emails are never rendered, even if a payload were to contain them.
 * Pagination is bounded (50 per page, offset window).
 */

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../api';
import type { AdminAuditRow } from '../../types';
import { StatusBadge } from '../design';
import { Table, THead, TBody, Tr, Th, Td } from '../design';
import { ErrorState, LoadingState } from '../ui';
import { LinkAction } from './ConfirmButton';
import { formatDateTime, shortId } from './statusMeta';

const PAGE_SIZE = 50;

export function AuditSection() {
  const [audit, setAudit] = useState<AdminAuditRow[] | null>(null);
  const [offset, setOffset] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback((nextOffset = 0) => {
    setLoadError(null);
    setAudit(null);
    api
      .listAdminAudit(PAGE_SIZE, nextOffset)
      .then((r) => {
        setAudit(r.audit);
        setOffset(nextOffset);
      })
      .catch((e: ApiError) => setLoadError(e.message));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loadError && !audit) {
    return <ErrorState message={loadError} onRetry={() => load(offset)} />;
  }
  if (!audit) {
    return <LoadingState label="Loading audit log…" />;
  }

  const hasOlder = audit.length === PAGE_SIZE;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Audit log</h2>
          <p className="mt-0.5 text-xs text-ink-tertiary">
            Bounded and redacted — metadata, IPs, correlation IDs, tokens and
            emails are never returned, so none are rendered here.
          </p>
        </div>
        <LinkAction onClick={() => load(offset)}>Refresh</LinkAction>
      </div>

      {audit.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong bg-surface-secondary p-10 text-center">
          <p className="text-sm font-medium text-ink-secondary">No audit events yet</p>
          <p className="mt-1 text-xs text-ink-tertiary">
            Actions recorded here once operators perform audited changes.
          </p>
        </div>
      ) : (
        <>
          <Table caption="Recent audit events — action, result, actor, target and time">
            <THead>
              <Tr>
                <Th>Action</Th>
                <Th>Result</Th>
                <Th>Actor</Th>
                <Th>Target</Th>
                <Th>When</Th>
              </Tr>
            </THead>
            <TBody>
              {audit.map((row) => (
                <Tr key={row.id}>
                  <Td>
                    <span className="font-medium text-ink">{row.action}</span>
                  </Td>
                  <Td>
                    <StatusBadge
                      tone={
                        row.result === 'success'
                          ? 'success'
                          : row.result === 'denied'
                            ? 'danger'
                            : 'neutral'
                      }
                    >
                      {row.result}
                    </StatusBadge>
                  </Td>
                  <Td>
                    <p className="text-xs text-ink">{row.actor_type}</p>
                    <p className="font-mono text-xs text-ink-tertiary">
                      {shortId(row.actor_id)}
                    </p>
                  </Td>
                  <Td>
                    <p className="text-xs text-ink">{row.target_type}</p>
                    <p className="font-mono text-xs text-ink-tertiary">
                      {shortId(row.target_id)}
                    </p>
                  </Td>
                  <Td className="tabular-nums text-ink-secondary">
                    {formatDateTime(row.created_at)}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-ink-tertiary" role="status">
              Showing the most recent {audit.length} events
              {offset > 0 ? ` (starting at #${offset + 1})` : ''} — 50 per page.
            </p>
            <div className="flex gap-2">
              <LinkAction
                onClick={() => load(offset - PAGE_SIZE)}
                disabled={offset === 0}
              >
                ← Newer
              </LinkAction>
              <LinkAction onClick={() => load(offset + PAGE_SIZE)} disabled={!hasOlder}>
                Older →
              </LinkAction>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
