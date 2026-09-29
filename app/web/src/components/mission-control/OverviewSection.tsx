/**
 * Mission Control — Overview (truthful ops summary).
 *
 * Every figure and chart here is derived from an actual API response:
 *
 *   - service / maintenance state  ← GET /api/status
 *   - session mix + activity       ← GET /api/admin/sessions
 *   - access entries (linked/…)    ← GET /api/admin/allowlist
 *   - quota policy state           ← GET /api/admin/quotas
 *   - recent audit volume          ← GET /api/admin/audit (bounded page)
 *
 * Deliberately absent: provider health, uptime, SLO, deployment status,
 * queue depth and cost. No API exposes them, so the page names them once,
 * in one quiet line, instead of estimating. Audit volume is presented with
 * its bounded-page caveat, never a fabricated total. A source that fails to
 * load shows "—", never a zero it did not measure.
 *
 * The six headline figures are ONE strip (hairlines between them), not six
 * cards: they are read together as "is anything off", and a card each made
 * them look like six separate stories.
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
  SectionHeader,
  StatusBadge,
} from '../design';
import { MetricStrip } from '../design/MetricStrip';
import type { MetricItem } from '../design/MetricStrip';
import { BarList, LineChart } from '../charts';
import { countPerDay, formatDayTime } from '../charts/dates';
import { sessionStatusCounts } from '../talent';
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

  /**
   * One figure per source, honest about each source on its own: still
   * loading, failed ("—", never a zero it did not measure), or loaded.
   */
  const figure = (
    source: SourceState<unknown>,
    item: Omit<MetricItem, 'value'> & { value: number },
  ): MetricItem => {
    if (source.error) {
      return { ...item, value: '—', context: 'Could not load', title: source.error };
    }
    return {
      ...item,
      value: item.value.toLocaleString(),
      loading: loading && source.data === null,
    };
  };

  const updated = statusData ? formatDayTime(statusData.updated_at) : null;

  return (
    <div className="space-y-6">
      <SectionHeader
        level={2}
        title="Overview"
        description="Live figures from the audited admin API."
        meta={
          updated ? (
            <span className="text-label tabular-nums text-ink-tertiary">Updated {updated}</span>
          ) : undefined
        }
        actions={
          <Button variant="secondary" onClick={load}>
            Refresh overview
          </Button>
        }
      />

      <GlassPanel padding="none" className="overflow-hidden">
        <MetricStrip
          label="Operations at a glance"
          hideLabel
          columns={6}
          items={[
            {
              label: 'Service state',
              value: status.error ? (
                <span className="text-sm font-medium tracking-normal text-ink-secondary">Not available</span>
              ) : statusData ? (
                <StatusBadge tone={maintenance.tone} className="px-2.5 py-1 text-label">
                  {maintenance.label}
                </StatusBadge>
              ) : (
                ''
              ),
              context: status.error ? status.error : statusData ? maintenance.detail : undefined,
              loading: !status.error && statusData === null,
            },
            figure(sessions, {
              label: 'Sessions',
              value: sessionsData.length,
              context: 'In the admin session view',
            }),
            figure(sessions, {
              label: 'Active sessions',
              value: activeNow,
              context: 'Created, waiting or in progress',
            }),
            figure(allowlist, {
              label: 'Linked access',
              value: linkedAccess,
              context: `Of ${allowlistData.length} access entries`,
            }),
            figure(quotas, {
              label: 'Quota policies enabled',
              value: enabledQuotas,
              context: `Of ${quotasData.length} configured`,
            }),
            figure(audit, {
              label: 'Audit events · 24h',
              value: recentAudit,
              context: 'Within the 50 most recent events',
            }),
          ]}
        />
      </GlassPanel>

      {/* Charts, bounded by the returned session data. Rows STRETCH (no
          `items-start`): the two cards in a row are peers and share a bottom
          edge; `ChartCard` fills the row and its body takes the slack. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartCard
          title="Session status mix"
          description={`${sessionsData.length} sessions in the admin view, largest first.`}
        >
          {sessions.error ? (
            <SourceError label="Session status mix" detail={sessions.error} onRetry={load} />
          ) : (
            <BarList
              title="Session status"
              data={sessionStatusCounts(sessionsData)}
              categoryHeader="Status"
              valueHeader="Sessions"
              isLoading={loading && sessions.data === null}
              emptyTitle="No sessions yet"
              emptyHint="Sessions will appear here once screening starts."
            />
          )}
        </ChartCard>

        <ChartCard
          title="Session activity"
          description="Sessions created per day, last 14 days."
        >
          {sessions.error ? (
            <SourceError label="Session activity" detail={sessions.error} onRetry={load} />
          ) : (
            <LineChart
              title="Sessions created per day"
              data={countPerDay(sessionsData)}
              unit="sessions"
              isLoading={loading && sessions.data === null}
              height={200}
            />
          )}
        </ChartCard>
      </div>

      {/* Access + quotas summary (no emails anywhere in Overview) */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartCard
          title="Access entries"
          description="Allowlist state. No email addresses are shown here."
        >
          {allowlist.error ? (
            <SourceError label="Access entries" detail={allowlist.error} onRetry={load} />
          ) : (
            <BarList
              title="Access entries summary"
              data={[
                { label: 'Linked', value: linkedAccess, tone: 'success' },
                {
                  label: 'Pending',
                  value: allowlistData.filter((e) => e.active && e.linked_user_id == null).length,
                },
                {
                  label: 'Disabled',
                  value: allowlistData.filter((e) => !e.active).length,
                  tone: 'neutral',
                },
              ]}
              order="none"
              categoryHeader="State"
              valueHeader="Entries"
              total={allowlistData.length}
              scale="total"
              isLoading={loading && allowlist.data === null}
              emptyTitle="No access entries yet"
            />
          )}
        </ChartCard>

        <ChartCard
          title="Quota policy state"
          description="Enabled policies enforce session limits; disabled ones do not."
          meta={
            quotas.data && quotasData.length > 0 ? (
              <span className="text-label tabular-nums text-ink-tertiary">{quotasData.length} configured</span>
            ) : undefined
          }
        >
          {quotas.error ? (
            <SourceError label="Quota policy state" detail={quotas.error} onRetry={load} />
          ) : (
            <BarList
              title="Quota policy state"
              data={[
                { label: 'Enabled', value: enabledQuotas, tone: 'success' },
                { label: 'Global scope', value: quotasData.filter((p) => p.scope === 'global').length },
              ]}
              order="none"
              categoryHeader="State"
              valueHeader="Policies"
              // Overlapping facts about one set of policies, not parts of a
              // whole: each bar is measured against every policy, and no
              // share column pretends they add up.
              total={quotasData.length}
              scale="total"
              showShare={false}
              isLoading={loading && quotas.data === null}
              emptyTitle="No quota policies configured"
              emptyHint="Quota enforcement is off."
            />
          )}
        </ChartCard>
      </div>

      {/* Truthful "not available", once. It used to be a panel of five
          identical "X · Not available" pills, which gave five missing
          signals the visual weight of five present ones. */}
      <p className="text-label text-ink-tertiary">
        <span className="font-medium text-ink-secondary">Operational areas without source data</span>
        {': '}
        {NOT_AVAILABLE.map((item, index) => (
          <span key={item.label}>
            <span title={item.note}>{item.label}</span>
            {index < NOT_AVAILABLE.length - 2 ? ', ' : index === NOT_AVAILABLE.length - 2 ? ' and ' : '. '}
          </span>
        ))}
        No API exposes them, so Mission Control does not estimate them.
      </p>
    </div>
  );
}

const NOT_AVAILABLE: ReadonlyArray<{ label: string; note: string }> = [
  { label: 'Provider health', note: 'No infrastructure-health API is exposed.' },
  { label: 'Uptime / SLO', note: 'No uptime or SLO measurement is exposed.' },
  { label: 'Deployment status', note: 'No deployment or rollout API is exposed.' },
  { label: 'Queue depth', note: 'No queue-health endpoint is exposed.' },
  {
    label: 'Cost',
    note: 'Quota units are abstract; no cost or currency data is exposed.',
  },
];

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
      message={`${label}: ${detail}`}
      onRetry={onRetry}
    />
  );
}
