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
 *
 * The page shell owns the page header; this section starts at a
 * `SectionHeader` so the surface never carries two titles.
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
import {
  Button,
  ChartCard,
  ErrorPanel,
  GlassPanel,
  InlineNotice,
  KpiCard,
  RevealGroup,
  RevealItem,
  SectionHeader,
  StatusBadge,
  cx,
} from '../design';
import { ChartDataTable, DonutChart, LineChart } from '../charts';
import { sessionStatusCounts, sessionsPerDay } from '../talent';
import {
  auditEventsInWindow,
  maintenanceMeta,
} from './statusMeta';

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
    <div className="space-y-6">
      <SectionHeader
        level={2}
        title="Overview"
        description="Live figures from the audited admin API."
        meta={
          statusData ? (
            <span className="text-[13px] text-ink-tertiary">
              Updated {formatUpdatedAt(statusData.updated_at)}
            </span>
          ) : undefined
        }
        actions={
          <Button size="sm" variant="secondary" onClick={load}>
            Refresh overview
          </Button>
        }
      />

      {/* Stat strip — one row of six at desktop width. */}
      <RevealGroup className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <RevealItem className="h-full">
          <GlassPanel padding="none" className="flex h-full flex-col p-5">
            <p className="text-[13px] font-medium text-ink-secondary">
              Service state
            </p>
            {status.error ? (
              <InlineNotice tone="warning" className="mt-3">
                Not available — {status.error}
              </InlineNotice>
            ) : statusData ? (
              <div className="mt-3">
                <StatusBadge tone={maintenance.tone} className="px-2.5 py-1 text-[13px]">
                  {maintenance.label}
                </StatusBadge>
                <p className="mt-2 text-[13px] leading-5 text-ink-tertiary">
                  {maintenance.detail}
                </p>
              </div>
            ) : (
              <p className="mt-3 text-sm text-ink-tertiary">Loading…</p>
            )}
          </GlassPanel>
        </RevealItem>

        <RevealItem className="h-full">
          <KpiCard
            label="Sessions"
            value={sessionsData.length}
            hint={sessions.error ? undefined : 'in the admin session view'}
            loading={loading && sessions.data === null && !sessions.error}
          />
        </RevealItem>
        <RevealItem className="h-full">
          <KpiCard
            label="Active sessions"
            value={activeNow}
            tone={activeNow > 0 ? 'warning' : 'default'}
            hint="created, waiting or in progress"
            loading={loading && sessions.data === null && !sessions.error}
          />
        </RevealItem>
        <RevealItem className="h-full">
          <KpiCard
            label="Linked access"
            value={linkedAccess}
            hint={`of ${allowlistData.length} access entries`}
            loading={loading && allowlist.data === null && !allowlist.error}
          />
        </RevealItem>
        <RevealItem className="h-full">
          <KpiCard
            label="Quota policies enabled"
            value={enabledQuotas}
            hint={`of ${quotasData.length} configured`}
            loading={loading && quotas.data === null && !quotas.error}
          />
        </RevealItem>
        <RevealItem className="h-full">
          <KpiCard
            label="Audit events · 24h"
            value={recentAudit}
            hint="within the 50 most recent events"
            loading={loading && audit.data === null && !audit.error}
          />
        </RevealItem>
      </RevealGroup>

      {/* Charts — bounded by the returned session data */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
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
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
        <GlassPanel as="section" aria-label="Access entries">
          <SectionHeader
            level={3}
            title="Access entries"
            description="Allowlist state at a glance — no email addresses are shown on this surface."
            className="mb-4"
          />
          {allowlist.error ? (
            <SourceError label="Access entries" detail={allowlist.error} onRetry={load} />
          ) : (
            <AccessSummary entries={allowlistData} loading={loading && allowlist.data === null} />
          )}
        </GlassPanel>

        <GlassPanel as="section" aria-label="Quota policy state">
          <SectionHeader
            level={3}
            title="Quota policy state"
            description="Enabled policies enforce session limits; disabled ones do not."
            className="mb-4"
          />
          {quotas.error ? (
            <SourceError label="Quota policy state" detail={quotas.error} onRetry={load} />
          ) : (
            <QuotaSummary policies={quotasData} loading={loading && quotas.data === null} />
          )}
        </GlassPanel>
      </div>

      {/* Truthful not-available block — no fabricated claims */}
      <GlassPanel as="section" aria-label="Operational areas without source data">
        <SectionHeader
          level={3}
          title="Operational areas without source data"
          description="No API endpoint exposes these signals, so Mission Control reports them as not available rather than estimating."
          className="mb-4"
        />
        <ul className="flex flex-wrap gap-2">
          {NOT_AVAILABLE.map((item) => (
            <NotAvailablePill key={item.label} label={item.label} note={item.note} />
          ))}
        </ul>
      </GlassPanel>
    </div>
  );
}

function formatUpdatedAt(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

interface BreakdownRow {
  label: string;
  value: number;
  fill: string;
}

/**
 * Compact breakdown: label, a proportion bar against the block's own total,
 * and the figure. The bar is decorative — the numbers and the sr-only data
 * table carry the meaning.
 */
function Breakdown({ rows, total }: { rows: BreakdownRow[]; total: number }) {
  return (
    <ul className="space-y-2.5">
      {rows.map((row) => {
        const pct = total > 0 ? Math.round((row.value / total) * 100) : 0;
        return (
          <li key={row.label} className="flex items-center gap-3">
            <span className="w-28 shrink-0 text-[13px] text-ink-secondary">
              {row.label}
            </span>
            <span
              aria-hidden="true"
              className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-ink/[0.06]"
            >
              <span
                className={cx('block h-full rounded-full', row.fill)}
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className="w-8 shrink-0 text-right text-sm font-semibold tabular-nums text-ink">
              {row.value}
            </span>
          </li>
        );
      })}
    </ul>
  );
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
  const rows: BreakdownRow[] = [
    { label: 'Linked', value: linked, fill: 'bg-success' },
    { label: 'Pending', value: pending, fill: 'bg-info' },
    { label: 'Disabled', value: disabled, fill: 'bg-ink-muted' },
  ];
  return (
    <div>
      {loading ? (
        <p className="text-sm text-ink-tertiary">Loading access summary…</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-ink-secondary">No access entries yet.</p>
      ) : (
        <>
          <Breakdown rows={rows} total={entries.length} />
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
  const rows: BreakdownRow[] = [
    { label: 'Enabled', value: enabled, fill: 'bg-success' },
    { label: 'Global scope', value: global, fill: 'bg-info' },
    { label: 'Total', value: policies.length, fill: 'bg-ink-muted' },
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
          <Breakdown rows={rows} total={policies.length} />
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

const NOT_AVAILABLE: ReadonlyArray<{ label: string; note: string }> = [
  { label: 'Provider health', note: 'No infrastructure-health API is exposed.' },
  { label: 'Uptime / SLO', note: 'No uptime or SLO measurement is exposed.' },
  { label: 'Deployment status', note: 'No deployment/rollout API is exposed.' },
  { label: 'Queue depth', note: 'No queue-health endpoint is exposed.' },
  {
    label: 'Cost',
    note: 'Quota units are abstract; no cost/currency data is exposed.',
  },
];

/**
 * The reason a signal is missing is a truth claim, so it stays in the DOM
 * (visually hidden) as well as in the pill's tooltip.
 */
function NotAvailablePill({ label, note }: { label: string; note: string }) {
  return (
    <li
      title={note}
      className="glass-sunken inline-flex items-center gap-2 rounded-full px-3 py-1.5"
    >
      <span className="text-[13px] font-medium text-ink">{label}</span>
      <span aria-hidden="true" className="text-ink-muted">
        ·
      </span>
      <span className="text-[13px] text-ink-tertiary">Not available</span>
      <span className="sr-only">{note}</span>
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
    <ErrorPanel
      compact
      className="h-full min-h-40"
      message={`${label} — ${detail}`}
      onRetry={onRetry}
    />
  );
}
