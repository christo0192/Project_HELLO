/**
 * Mission Control — Overview (truthful ops summary).
 *
 * Every KPI and chart here is derived from an actual API response:
 *
 *   - service / maintenance state  ← GET /api/status
 *   - session mix + activity       ← GET /api/admin/sessions
 *   - access entries (linked/…)    ← GET /api/admin/allowlist
 *   - quota policy state           ← GET /api/admin/quotas
 *   - recent audit volume          ← GET /api/admin/audit (bounded page)
 *
 * Deliberately absent: provider health, uptime, SLO, deployment status,
 * queue depth and cost. No API exposes them, so the page shows a truthful
 * "not available" panel instead of estimating. Audit volume is presented
 * with its bounded-page caveat — never a fabricated total.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../api';
import type {
  AdminAllowlistEntry,
  AdminAuditRow,
  AdminSessionRow,
  PublicStatus,
  QuotaPolicy,
} from '../../types';
import { ChartCard, KpiCard, PageHeader } from '../design';
import { StatusBadge } from '../design';
import { DonutChart, LineChart } from '../charts';
import { sessionStatusCounts, sessionsPerDay } from '../talent';
import { ChartDataTable } from '../charts';
import {
  auditEventsInWindow,
  maintenanceMeta,
} from './statusMeta';
import { buttonClassNames } from './buttonStyles';

interface SourceState<T> {
  data: T | null;
  error: string | null;
}

function initialState<T>(): SourceState<T> {
  return { data: null, error: null };
}

export function OverviewSection() {
  const [status, setStatus] = useState<SourceState<PublicStatus>>(initialState);
  const [sessions, setSessions] = useState<SourceState<AdminSessionRow[]>>(
    initialState,
  );
  const [allowlist, setAllowlist] = useState<SourceState<AdminAllowlistEntry[]>>(
    initialState,
  );
  const [quotas, setQuotas] = useState<SourceState<QuotaPolicy[]>>(
    initialState,
  );
  const [audit, setAudit] = useState<SourceState<AdminAuditRow[]>>(
    initialState,
  );
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setStatus(initialState());
    setSessions(initialState());
    setAllowlist(initialState());
    setQuotas(initialState());
    setAudit(initialState());

    const settle = <T,>(setter: (s: SourceState<T>) => void) => ({
      ok: (data: T) => setter({ data, error: null }),
      fail: (e: ApiError) => setter({ data: null, error: e.message }),
    });

    api
      .status()
      .then(settle(setStatus).ok, settle(setStatus).fail);
    api
      .listAdminSessions()
      .then((r) => settle(setSessions).ok(r.sessions), settle(setSessions).fail);
    api
      .listAdminAllowlist()
      .then(
        (r) => settle(setAllowlist).ok(r.entries),
        settle(setAllowlist).fail,
      );
    api
      .listAdminQuotas()
      .then(
        (r) => settle(setQuotas).ok(r.policies),
        settle(setQuotas).fail,
      );
    api
      .listAdminAudit(50, 0)
      .then((r) => settle(setAudit).ok(r.audit), settle(setAudit).fail)
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const statusData = status.data;
  const sessionsData = sessions.data ?? [];
  const allowlistData = allowlist.data ?? [];
  const quotasData = quotas.data ?? [];
  const auditData = audit.data ?? [];

  const activeNow = sessionsData.filter((s) =>
    ['created', 'waiting', 'in_progress'].includes(s.status),
  ).length;
  const linkedAccess = allowlistData.filter(
    (e) => e.active && e.linked_user_id != null,
  ).length;
  const enabledQuotas = quotasData.filter((p) => p.enabled).length;
  const recentAudit = auditEventsInWindow(auditData, 24);

  const maintenance = maintenanceMeta(statusData);

  return (
    <div>
      <PageHeader
        eyebrow="Mission Control"
        title="Overview"
        description="Live operational summary — every figure is sourced from the audited admin API; nothing is estimated."
        actions={
          <button
            type="button"
            onClick={load}
            className={buttonClassNames('secondary')}
          >
            Refresh overview
          </button>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Service / maintenance state */}
        <div className="rounded-xl border border-line bg-surface p-5 shadow-card">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-secondary">
            Service state
          </p>
          <div className="mt-2">
            {status.error ? (
              <Unavailable detail={status.error} />
            ) : statusData ? (
              <>
                <StatusBadge tone={maintenance.tone}>{maintenance.label}</StatusBadge>
                <p className="mt-2 text-xs text-ink-tertiary">
                  {maintenance.detail}
                </p>
                <p className="mt-1 text-xs text-ink-tertiary">
                  Updated {formatUpdatedAt(statusData.updated_at)}
                </p>
              </>
            ) : (
              <p className="text-sm text-ink-tertiary">Loading…</p>
            )}
          </div>
        </div>

        <KpiCard
          label="Sessions"
          value={sessionsData.length}
          hint={sessions.error ? undefined : 'in the admin session view'}
          loading={loading && sessions.data === null && !sessions.error}
        />
        <KpiCard
          label="Active sessions"
          value={activeNow}
          tone={activeNow > 0 ? 'warning' : 'default'}
          hint="created, waiting or in progress"
          loading={loading && sessions.data === null && !sessions.error}
        />
        <KpiCard
          label="Linked access"
          value={linkedAccess}
          hint={`of ${allowlistData.length} access entries`}
          loading={loading && allowlist.data === null && !allowlist.error}
        />
        <KpiCard
          label="Quota policies enabled"
          value={enabledQuotas}
          hint={`of ${quotasData.length} configured`}
          loading={loading && quotas.data === null && !quotas.error}
        />
        <KpiCard
          label="Audit events · 24h"
          value={recentAudit}
          hint="within the 50 most recent events"
          loading={loading && audit.data === null && !audit.error}
        />
      </div>

      {/* Charts — bounded by the returned session data */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartCard
          title="Session status mix"
          description={`${sessionsData.length} sessions in the admin view.`}
        >
          {sessions.error ? (
            <SourceError label="Session status mix" detail={sessions.error} onRetry={load} />
          ) : (
            <DonutChart
              title="Session status"
              data={sessionStatusCounts(sessionsData)}
              isLoading={loading && sessions.data === null}
              height={240}
            />
          )}
        </ChartCard>

        <ChartCard
          title="Session activity"
          description="Sessions created per day over the last 14 days (real counts, zero-filled)."
        >
          {sessions.error ? (
            <SourceError label="Session activity" detail={sessions.error} onRetry={load} />
          ) : (
            <LineChart
              title="Sessions created per day"
              data={sessionsPerDay(sessionsData)}
              unit="sessions"
              isLoading={loading && sessions.data === null}
              height={220}
            />
          )}
        </ChartCard>
      </div>

      {/* Access + quotas summary (no emails anywhere in Overview) */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartCard title="Access entries" description="Allowlist state at a glance — no email addresses are shown on this surface.">
          {allowlist.error ? (
            <SourceError label="Access entries" detail={allowlist.error} onRetry={load} />
          ) : (
            <AccessSummary entries={allowlistData} loading={loading && allowlist.data === null} />
          )}
        </ChartCard>

        <ChartCard title="Quota policy state" description="Enabled policies enforce session limits; disabled ones do not.">
          {quotas.error ? (
            <SourceError label="Quota policy state" detail={quotas.error} onRetry={load} />
          ) : (
            <QuotaSummary policies={quotasData} loading={loading && quotas.data === null} />
          )}
        </ChartCard>
      </div>

      {/* Truthful not-available panel — no fabricated claims */}
      <div className="mt-6">
        <ChartCard
          title="Operational areas without source data"
          description="No API endpoint exposes these signals, so Mission Control reports them as not available rather than estimating."
        >
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <NotAvailableItem label="Provider health" note="No infrastructure-health API is exposed." />
            <NotAvailableItem label="Uptime / SLO" note="No uptime or SLO measurement is exposed." />
            <NotAvailableItem label="Deployment status" note="No deployment/rollout API is exposed." />
            <NotAvailableItem label="Queue depth" note="No queue-health endpoint is exposed." />
            <NotAvailableItem label="Cost" note="Quota units are abstract; no cost/currency data is exposed." />
          </ul>
        </ChartCard>
      </div>
    </div>
  );
}

function formatUpdatedAt(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function AccessSummary({
  entries,
  loading,
}: {
  entries: AdminAllowlistEntry[];
  loading: boolean;
}) {
  const linked = entries.filter((e) => e.active && e.linked_user_id != null).length;
  const pending = entries.filter((e) => e.active && e.linked_user_id == null).length;
  const disabled = entries.filter((e) => !e.active).length;
  const rows = [
    { label: 'Linked', value: linked },
    { label: 'Pending', value: pending },
    { label: 'Disabled', value: disabled },
  ];
  return (
    <div>
      {loading ? (
        <p className="text-sm text-ink-tertiary">Loading access summary…</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-ink-secondary">No access entries yet.</p>
      ) : (
        <>
          <ul className="space-y-2">
            {rows.map((row) => (
              <li key={row.label} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-ink-secondary">{row.label}</span>
                <span className="font-semibold tabular-nums text-ink">{row.value}</span>
              </li>
            ))}
          </ul>
          <ChartDataTable
            caption="Access entries summary data"
            headers={['State', 'Count']}
            rows={rows.map((r) => ({ cells: [r.label, r.value] }))}
          />
        </>
      )}
    </div>
  );
}

function QuotaSummary({
  policies,
  loading,
}: {
  policies: QuotaPolicy[];
  loading: boolean;
}) {
  const enabled = policies.filter((p) => p.enabled).length;
  const global = policies.filter((p) => p.scope === 'global').length;
  const rows = [
    { label: 'Enabled', value: enabled },
    { label: 'Global scope', value: global },
    { label: 'Total', value: policies.length },
  ];
  return (
    <div>
      {loading ? (
        <p className="text-sm text-ink-tertiary">Loading quota state…</p>
      ) : policies.length === 0 ? (
        <p className="text-sm text-ink-secondary">
          No quota policies configured — quota enforcement is off.
        </p>
      ) : (
        <>
          <ul className="space-y-2">
            {rows.map((row) => (
              <li key={row.label} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-ink-secondary">{row.label}</span>
                <span className="font-semibold tabular-nums text-ink">{row.value}</span>
              </li>
            ))}
          </ul>
          <ChartDataTable
            caption="Quota policy state data"
            headers={['State', 'Count']}
            rows={rows.map((r) => ({ cells: [r.label, r.value] }))}
          />
        </>
      )}
    </div>
  );
}

function Unavailable({ detail }: { detail: string }) {
  return (
    <div>
      <p className="text-sm font-medium text-warning">Not available</p>
      <p className="mt-1 text-xs text-ink-tertiary">{detail}</p>
    </div>
  );
}

function NotAvailableItem({ label, note }: { label: string; note: string }) {
  return (
    <li className="rounded-lg border border-dashed border-line-strong bg-surface-secondary p-4">
      <p className="text-sm font-medium text-ink">{label}</p>
      <p className="mt-1 text-xs text-ink-tertiary">{note}</p>
      <p className="mt-1 text-xs font-medium text-warning">Not available</p>
    </li>
  );
}

function SourceError({
  label,
  detail,
  onRetry,
}: {
  label: string;
  detail: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex h-full min-h-40 flex-col items-center justify-center gap-3 rounded-xl border border-error/30 bg-error-soft px-4 text-center"
    >
      <p className="max-w-md text-sm text-error">{label} — {detail}</p>
      <button
        type="button"
        onClick={onRetry}
        className={buttonClassNames('secondary')}
      >
        Try again
      </button>
    </div>
  );
}
