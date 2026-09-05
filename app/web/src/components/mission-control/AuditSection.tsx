/**
 * Mission Control — Audit (bounded, redacted audit view).
 *
 * Data: GET /api/admin/audit?limit&offset — the backend returns ONLY
 * allowlisted fields (id, action, actor_type, actor_id, target_type,
 * target_id, result, created_at). This surface renders exactly those
 * fields and nothing else: metadata, IPs, correlation IDs, tokens and
 * emails are never rendered, even if a payload were to contain them.
 * Pagination is bounded (50 per page, offset window) and stays server
 * driven — `Pagination` is fed a state derived from the offset, never a
 * client-side slice.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../api';
import type { AdminAuditRow } from '../../types';
import {
  Button,
  EmptyPanel,
  ErrorPanel,
  LoadingPanel,
  Pagination,
  SectionHeader,
  StatusBadge,
  TBody,
  THead,
  Table,
  Td,
  Th,
  Tr,
} from '../design';
import { formatDateTime, shortId } from './statusMeta';

const PAGE_SIZE = 50 as const;

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
    return <ErrorPanel message={loadError} onRetry={() => load(offset)} />;
  }
  if (!audit) {
    return <LoadingPanel label="Loading audit log…" />;
  }

  const hasOlder = audit.length === PAGE_SIZE;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  // Offset paging: the window is authoritative, the total is only known up
  // to the rows fetched so far, and one further page exists exactly when
  // this one came back full.
  const pageState = {
    page,
    pageSize: PAGE_SIZE,
    pageCount: hasOlder ? page + 1 : page,
    total: offset + audit.length,
    from: audit.length === 0 ? 0 : offset + 1,
    to: offset + audit.length,
    setPage: (next: number) => load((next - 1) * PAGE_SIZE),
    setPageSize: () => undefined,
  };

  return (
    <div className="space-y-5">
      <SectionHeader
        level={2}
        title="Audit log"
        description="Bounded and redacted — metadata, IPs, correlation IDs, tokens and emails are never returned, so none are rendered here."
        actions={
          <Button size="sm" variant="secondary" onClick={() => load(offset)}>
            Refresh
          </Button>
        }
      />

      {audit.length === 0 ? (
        <EmptyPanel
          title="No audit events yet"
          hint="Actions recorded here once operators perform audited changes."
        />
      ) : (
        <div>
          <Table caption="Recent audit events — action, result, actor, target and time" maxHeight="34rem">
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
                    <span className="inline-block rounded-md bg-surface-tertiary px-1.5 py-0.5 font-mono text-xs text-ink">
                      {row.action}
                    </span>
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

          <Pagination state={pageState} noun="events" hidePageSize />

          <p className="px-1 pt-2 text-xs text-ink-tertiary" role="status">
            Showing the most recent {audit.length} events
            {offset > 0 ? ` (starting at #${offset + 1})` : ''} — 50 per page.
          </p>
        </div>
      )}
    </div>
  );
}
