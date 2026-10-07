/**
 * Mission Control: R1 usage and allocation.
 *
 * Every figure comes from two admin reads and nothing is invented:
 *
 *   - GET /api/admin/r1/settings  the switches, caps and the API's own R1 status
 *   - GET /api/admin/r1/usage     this month's budget row and WebRTC estimate
 *
 * The four tiles answer "is R1 live, how much of its allowance is gone, how
 * many interviews started, and how close is the shared LiveKit pool to the
 * pause line". Two breakdowns sit under them: the allowance (used, held by
 * links already sent, still free) and where the pool's minutes went (R1,
 * phone, legacy browser). A source that fails to load shows a dash, never a
 * zero it did not measure. The page shell owns the page header; this section
 * starts at a `SectionHeader`.
 *
 * The allowance is NOT an R1-only budget. The capacity RPCs hold the cap
 * against the shared WebRTC pool (phone included, with a 15% margin, never
 * below the owner's dashboard reading) plus R1's held links, so "used",
 * "more sends fit" and "free" are the API's own figures for that test
 * (`committed_minutes`, `sends_left`). Subtracting R1's minutes from the cap
 * here would promise sends the RPC refuses.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../api';
import type { R1SettingsResponse, R1UsageResponse } from '../../lib/r1-types';
import {
  Button,
  ChartCard,
  ErrorPanel,
  GlassPanel,
  InlineNotice,
  SectionHeader,
  StatusBadge,
} from '../design';
import { buttonClass } from '../design/Button';
import { MetricStrip } from '../design/MetricStrip';
import type { MetricItem } from '../design/MetricStrip';
import { BarList } from '../charts';
import { formatDateTime } from '../../lib/datetime';
import {
  formatMinutes,
  formatReading,
  isReadingStale,
  percentOf,
  r1Ceiling,
  r1FreeMinutes,
  r1PoolMinutes,
  r1RunState,
  readingMonthLabel,
  usageTone,
} from '../../lib/r1';

interface Source<T> {
  data: T | null;
  error: string | null;
}

function empty<T>(): Source<T> {
  return { data: null, error: null };
}

const DESCRIPTION =
  'Usage and allocation of the R1 sales role-play interviews, which share LiveKit ' +
  'minutes with phone.';

function monthLabel(monthStart: string): string {
  const date = new Date(`${monthStart}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return monthStart;
  return date.toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export function R1Section() {
  const [usage, setUsage] = useState<Source<R1UsageResponse>>(empty);
  const [settings, setSettings] = useState<Source<R1SettingsResponse>>(empty);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setUsage(empty());
    setSettings(empty());
    const message = (e: unknown) =>
      e instanceof ApiError || e instanceof Error ? e.message : 'Could not load';
    const usageDone = api
      .getR1Usage()
      .then((data) => setUsage({ data, error: null }))
      .catch((e: unknown) => setUsage({ data: null, error: message(e) }));
    const settingsDone = api
      .getR1Settings()
      .then((data) => setSettings({ data, error: null }))
      .catch((e: unknown) => setSettings({ data: null, error: message(e) }));
    void Promise.all([usageDone, settingsDone]).finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const u = usage.data;
  const s = settings.data;
  const run = s ? r1RunState(s, s.runtime ?? u?.runtime) : null;

  const ceiling = u ? r1Ceiling(u) : 0;
  const committed = u ? u.committed_minutes : 0;
  const committedPct = u ? percentOf(committed, ceiling) : null;
  const poolPct = u ? percentOf(u.guard_minutes, u.pause_line_minutes) : null;
  const readingStale = u ? isReadingStale(u.dashboard_read_at, u.month_start) : false;

  const dash = (source: Source<unknown>, item: MetricItem): MetricItem =>
    source.error
      ? { ...item, value: '—', unit: undefined, context: 'Could not load', title: source.error }
      : { ...item, loading: loading && source.data === null };

  const statusItem: MetricItem = settings.error
    ? { label: 'R1 status', value: '—', context: 'Could not load', title: settings.error }
    : {
        label: 'R1 status',
        value: run ? (
          <StatusBadge tone={run.tone} className="px-2.5 py-1 text-label">
            {run.label}
          </StatusBadge>
        ) : (
          ''
        ),
        context: run?.detail,
        loading: loading && run === null,
      };

  const items: MetricItem[] = [
    statusItem,
    dash(usage, {
      label: 'R1 allowance used',
      value: u ? formatMinutes(committed) : '',
      unit: u ? `/ ${formatMinutes(ceiling)} min` : undefined,
      context: u
        ? `${u.sends_left} more ${u.sends_left === 1 ? 'send' : 'sends'} fit` +
          (committedPct !== null ? ` · ${committedPct}% committed` : '')
        : undefined,
      attention: committedPct !== null && committedPct >= 90,
    }),
    dash(usage, {
      label: 'Interviews started',
      value: u ? u.starts_admitted.toLocaleString() : '',
      context: u
        ? `${formatMinutes(u.minutes_used)} min taken · ` +
          `${formatMinutes(u.minutes_reserved)} min held`
        : undefined,
    }),
    dash(usage, {
      label: 'Shared WebRTC pool',
      value: u ? (poolPct === null ? '—' : `${poolPct}%`) : '',
      context: u
        ? `${formatMinutes(u.guard_minutes)} of ` +
          `${formatMinutes(u.pause_line_minutes)} min pause line`
        : undefined,
      tone: usageTone(poolPct),
      attention: poolPct !== null && poolPct >= 75,
    }),
  ];

  return (
    <div className="space-y-6">
      <SectionHeader
        level={2}
        title="R1"
        description={DESCRIPTION}
        meta={u ? monthLabel(u.month_start) : undefined}
        actions={
          <>
            <Button variant="secondary" onClick={load}>
              Refresh R1
            </Button>
            <Link to="/admin/r1" className={buttonClass('secondary', 'md')}>
              R1 settings
            </Link>
          </>
        }
      />

      {run && run.tone === 'danger' && (
        <InlineNotice tone="danger" role="alert">
          {run.detail}
        </InlineNotice>
      )}

      <GlassPanel padding="none" className="overflow-hidden">
        <MetricStrip label="R1 at a glance" hideLabel columns={4} items={items} />
      </GlassPanel>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartCard
          title="R1 allowance"
          description={
            u
              ? `Against the ${formatMinutes(ceiling)}-minute ceiling (the lower of the cap and ` +
                'the pause line). Used: the shared pool, phone included, or R1’s started ' +
                'interviews if higher. Held: links already sent.'
              : 'Minutes against the monthly ceiling.'
          }
        >
          {usage.error ? (
            <ErrorPanel
              compact
              className="h-full min-h-40"
              message={`R1 allowance: ${usage.error}`}
              onRetry={load}
            />
          ) : (
            <BarList
              title="R1 allowance"
              data={
                u
                  ? [
                      { label: 'Used', value: r1PoolMinutes(u), tone: 'info' },
                      {
                        label: 'Held',
                        value: u.minutes_reserved,
                        tone: 'warning',
                      },
                      {
                        label: 'Free',
                        value: r1FreeMinutes(u),
                        tone: 'success',
                      },
                    ]
                  : []
              }
              order="none"
              categoryHeader="Part of the allowance"
              valueHeader="Minutes"
              total={ceiling}
              scale="total"
              isLoading={loading && usage.data === null}
              emptyTitle="No allowance configured"
              emptyHint="Set a monthly cap in R1 settings."
            />
          )}
        </ChartCard>

        <ChartCard
          title="Where the pool’s minutes went"
          description="Estimated from our own records for the month, before the 15% safety margin."
        >
          {usage.error ? (
            <ErrorPanel
              compact
              className="h-full min-h-40"
              message={`WebRTC minutes: ${usage.error}`}
              onRetry={load}
            />
          ) : (
            <BarList
              title="WebRTC minutes by lane"
              data={
                u
                  ? [
                      { label: 'R1 interviews', value: u.r1_minutes },
                      { label: 'Phone', value: u.phone_minutes },
                      { label: 'Legacy browser', value: u.legacy_browser_minutes, tone: 'neutral' },
                    ]
                  : []
              }
              categoryHeader="Lane"
              valueHeader="Minutes"
              isLoading={loading && usage.data === null}
              emptyTitle="No minutes recorded this month"
              emptyHint="Minutes appear here once calls or R1 interviews run."
            />
          )}
        </ChartCard>
      </div>

      {u && readingStale && u.dashboard_read_at && (
        <InlineNotice tone="warning" role="status">
          The last LiveKit dashboard reading is from {readingMonthLabel(u.dashboard_read_at)}, but
          the guard still counts it this month. Record this month’s reading in R1 settings.
        </InlineNotice>
      )}

      {u && (
        <p className="text-label text-ink-tertiary">
          {u.dashboard_read_at ? (
            <>
              LiveKit dashboard reading: {formatReading(u.dashboard_minutes)} min, read{' '}
              {formatDateTime(u.dashboard_read_at)}. The guard never goes below it.
            </>
          ) : (
            <>
              No LiveKit dashboard reading is recorded, so the guard relies on the estimate alone.
              Record a reading in R1 settings.
            </>
          )}
        </p>
      )}
    </div>
  );
}
