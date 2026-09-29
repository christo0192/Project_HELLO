/**
 * ScreeningKpis — the screening scoreboard for a non-technical audience.
 *
 * DESIGN INTENT. Fifteen numbers as fifteen equal cards is a wall, and a wall
 * gets skimmed once and never returned to. They are five ROWS of one report,
 * each answering one question, in the order the work actually happens:
 *
 *    Reach               did we get to them?
 *    Call volume         how much dialling did that take?
 *    Conversation        did they actually talk to us?
 *    Screening decision  what did the screening conclude?
 *    Team decision       what did the team do about it?
 *
 * Each row is a `MetricStrip`: the question on the left, its figures on a
 * shared four-column grid divided by hairlines, so a figure sits in the same
 * column as its neighbours above and below and the whole block reads like a
 * well-set table rather than a pile of tiles. The daily trends sit beside it,
 * and the definitions are one disclosure at the bottom.
 *
 * TRUTHFULNESS RULES, because this is read by people who will make hiring
 * decisions from it and cannot audit the SQL:
 *
 *  - Every figure is a direct sum from the stored rollup. Nothing is
 *    estimated, extrapolated or back-filled.
 *  - `hr_awaiting` is shown as a footnote under the team row rather than
 *    folded into "Not advanced". Folding it in would make the rejection rate
 *    climb whenever screening got FASTER, which reads exactly like an insight
 *    and is an artefact.
 *  - Rates are suppressed (— rather than 0%) when the denominator is zero. A
 *    "0%" connect rate on a day nobody was dialled is a lie of arithmetic.
 *  - The "how these are calculated" block is not decoration; it is the only
 *    way a non-technical reader can tell a real drop from a definition they
 *    misread.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import type { FunnelDailyRow, FunnelSummaryResponse, Role } from '../../types';
import { ErrorPanel, GlassPanel, InlineNotice, SectionHeader, controlClass, cx } from '../design';
import { MetricStrip } from '../design/MetricStrip';
import type { MetricItem } from '../design/MetricStrip';
import { LineChart } from '../charts';
import { formatDayTime } from '../charts/dates';
import { buildRateSeries, pct, pctLabel } from './rates';
import { uniqueAgentLabels } from '../../lib/role-label';

/** Selectable trailing windows. 30 is the default the endpoint already uses. */
const RANGE_OPTIONS = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
] as const;

type RangeDays = (typeof RANGE_OPTIONS)[number]['days'];

/** Series colours: the approved success and error values, matching the dots. */
const QUALIFIED_COLOUR = '#398AA2';
const DISQUALIFIED_COLOUR = '#B45A72';

/** YYYY-MM-DD `days` before today (UTC), matching the server's own helper. */
function dayOffset(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

export interface ScreeningKpisProps {
  className?: string;
  /** Roles for the filter. Omitted or empty hides the control entirely. */
  roles?: Role[];
}

export function ScreeningKpis({ className, roles: rolesProp }: ScreeningKpisProps) {
  const [rangeDays, setRangeDays] = useState<RangeDays>(30);
  // Self-loaded so the block can be dropped onto any page without that page
  // having to know it needs roles. A caller that already has them passes them
  // in and this never fires.
  const [loadedRoles, setLoadedRoles] = useState<Role[]>([]);
  const roles = rolesProp ?? loadedRoles;
  // The filter NAMES each role by its agent (owner request), falling back to
  // the title for a role without one. Two roles can share a label (two
  // "Sales Program Advisor"s exist today), so exact duplicates are numbered;
  // the option VALUE stays the role id, so the filter itself never changes.
  const agentLabels = useMemo(() => uniqueAgentLabels(roles), [roles]);
  const [roleId, setRoleId] = useState<string>('');
  const [data, setData] = useState<FunnelSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Monotonic request id. Click 90 then 7: if the 90-day response lands second
  // it would repaint the panel while the control and the notes both still say
  // "7 days": 90 days of numbers under a 7-day label, with no error.
  const requestSeq = useRef(0);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    // Cleared per attempt. A 403 from an earlier, overtaken request must not
    // survive into a load that then succeeds: the flag hides the whole panel,
    // so a sticky one would take a working dashboard away on the strength of a
    // response the guard below has already decided to discard.
    setForbidden(false);
    try {
      const res = await api.getScreeningFunnel({
        from: dayOffset(rangeDays - 1),
        to: dayOffset(0),
        ...(roleId ? { role_id: roleId } : {}),
      });
      if (seq !== requestSeq.current) return;
      setData(res);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      // A viewer has no access to screening metrics. Showing them a red panel
      // with a "Try again" button that can never succeed makes the whole
      // dashboard look broken; the honest response is to show nothing.
      if (err instanceof ApiError && err.status === 403) {
        setForbidden(true);
        setData(null);
        return;
      }
      setError(
        err instanceof ApiError
          ? err.message
          : 'Could not load screening metrics.',
      );
      setData(null);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [rangeDays, roleId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (rolesProp) return;
    let cancelled = false;
    void api
      .listRoles()
      .then((rs) => { if (!cancelled) setLoadedRoles(rs); })
      // A missing role filter is a degraded control, never a broken panel.
      .catch(() => { if (!cancelled) setLoadedRoles([]); });
    return () => { cancelled = true; };
  }, [rolesProp]);

  /**
   * Totals with every field guaranteed present. The web app and API deploy
   * independently, so a UI-ahead-of-API window returns a payload without
   * 0098's fields, and `t.hr_awaiting.toLocaleString()` on `undefined` throws
   * during render, taking the whole DashboardPage down, not just this panel.
   */
  const t = useMemo(() => {
    if (!data) return null;
    const raw = data.totals as unknown as Record<string, number | undefined>;
    const n = (k: string): number => (typeof raw[k] === 'number' ? (raw[k] as number) : 0);
    return {
      candidates_total: n('candidates_total'), attempts_total: n('attempts_total'),
      connects_total: n('connects_total'), dialed: n('dialed'), connected: n('connected'),
      answered_ge1: n('answered_ge1'), scored: n('scored'), qualified: n('qualified'),
      disqualified: n('disqualified'), on_hold: n('on_hold'), human_review: n('human_review'),
      hr_qualified: n('hr_qualified'), hr_disqualified: n('hr_disqualified'),
      hr_awaiting: n('hr_awaiting'), hr_unknown: n('hr_unknown'),
    };
  }, [data]);

  /**
   * Everything below is TOLD to us, never deduced from the numbers. Three
   * separate attempts to infer these from the payload were each wrong for the
   * configuration this system actually ships with:
   *
   *  - `refreshed_at === null` was read as "never computed". It actually means
   *    "no rows in this window", so a quiet week or an unused role announced
   *    that a roll-up which ran an hour ago had never run.
   *  - "no observable HR states" was read as "not configured". But a mapping
   *    with the NULL-by-default `reference_check_stage_id` still produces
   *    `hr_awaiting > 0`, which defeated the check and rendered a
   *    structurally-unreachable "0 advanced / 0 not advanced" as measurement.
   *  - Missing 0098 fields were zero-filled, making a pre-migration API
   *    indistinguishable from a genuinely empty pipeline.
   */
  const meta = data?.meta;
  // Absent meta = an API older than this field. Treat every fact as unknown
  // and suppress rather than assert.
  // FAIL CLOSED, all of them. `meta?.schema_current !== false` read `undefined`
  // (an API too old to send `meta` at all) as "the columns are present", so
  // the one deploy window this flag exists to survive was the one window it
  // asserted the opposite.
  const schemaCurrent = meta?.schema_current === true;
  const hrConfigured = meta?.hr_tracking_configured === true;
  // Tri-state: a timestamp, `null` = never run, `unknown` = the probe failed.
  // Announcing "never calculated" on a failed probe put that banner directly
  // above non-zero figures that had loaded perfectly well.
  const freshnessKnown = meta?.rollup_freshness_known === true;
  const rollupRefreshedAt = freshnessKnown ? (meta?.rollup_refreshed_at ?? null) : null;
  /**
   * "Never computed" is a claim about a system, and it is only safe to make
   * when the figures agree with it. The heartbeat is written by
   * `refresh_funnel_rollup`, which 0098's backfill deliberately does NOT call,
   * so a tenant whose roll-up has been running for weeks has an EMPTY heartbeat
   * from the moment 0098 is applied until the next 15-minute pass. Announcing
   * "these figures have not been calculated yet" over `Candidates dialled
   * 4,812` is the same lie this field was added to prevent, one level up.
   * Requiring the numbers to actually be zero costs nothing and closes it.
   */
  const everythingZero = !t || Object.values(t).every((v) => v === 0);
  const neverComputed =
    data !== null && freshnessKnown && rollupRefreshedAt === null && everythingZero
    // A server too old to have the columns has a better explanation available,
    // and the two messages contradict each other: one says the figures will
    // read zero, the other that they are hidden RATHER than shown as zero.
    && schemaCurrent;
  const hrUnavailable = data !== null && (!schemaCurrent || !hrConfigured);
  const staleBeyondDays = meta?.refresh_window_days ?? null;

  /**
   * Derived counts. Each is a subtraction of two sums from the same rollup
   * rows, so they cannot disagree with the figures they are derived from.
   */
  const derived = useMemo(() => {
    if (!t) return null;
    return {
      // Connected but never produced a usable answer: reached a human and
      // learned nothing. The number worth acting on.
      connectedNoAnswer: Math.max(0, t.connected - t.answered_ge1),
      // Dialled and never reached a human at all.
      neverConnected: Math.max(0, t.dialed - t.connected),
      // `hold` + `human_review`: the bot declined to decide. Shown so
      // qualified + disqualified + this reconciles against `scored`.
      needsReview: t.on_hold + t.human_review,
    };
  }, [t]);

  /**
   * `connected` (an attempt's `answered_at`) and `answered_ge1` (question
   * dispositions) are written by two independent paths, so a crashed job or a
   * missed carrier webhook can record answers for a call never marked answered.
   * `connectedNoAnswer` clamps at 0, but the two SOURCE figures still render,
   * so the reader is left looking at "Candidates reached 3" above "Answered
   * questions 5" with the bucket that would reconcile them showing 0. Say so
   * rather than letting the clamp quietly hide it.
   */
  const countsDisagree =
    !!t && (t.answered_ge1 > t.connected || t.connected > t.dialed);

  /**
   * Rate series with the no-denominator days REMOVED rather than plotted as 0.
   *
   * `?? 0` here was the panel's worst inconsistency: the figures refuse to
   * print "0%" for an unknown rate, and the charts then told exactly that lie
   * at higher visual weight. A weekend with no dials rendered as a
   * connect-rate CLIFF to zero, indistinguishable from every phone line
   * failing. Dropping the point leaves a gap, which is what "we cannot know"
   * should look like.
   */
  // `data.series` ABSENT, not empty: the same split-deploy window the `t` memo
  // exists for. `rows.map` on undefined throws during render and takes the
  // whole DashboardPage down, not just this panel.
  const seriesRows = useMemo<FunnelDailyRow[]>(
    () => (Array.isArray(data?.series) ? (data!.series as FunnelDailyRow[]) : []),
    [data],
  );

  const rateSeries = useCallback(
    (
      num: (row: FunnelDailyRow) => number | undefined,
      den: (row: FunnelDailyRow) => number | undefined,
    ) => buildRateSeries(seriesRows, num, den),
    [seriesRows],
  );

  const connectSeries = useMemo(
    () => rateSeries((r) => r.connected, (r) => r.dialed),
    [rateSeries],
  );
  const qualifiedSeries = useMemo(
    () => rateSeries((r) => r.qualified, (r) => r.scored),
    [rateSeries],
  );
  const disqualifiedSeries = useMemo(
    () => rateSeries((r) => r.disqualified, (r) => r.scored),
    [rateSeries],
  );

  /**
   * Not an error state: this role simply cannot read screening metrics, so
   * the panel is absent rather than broken. Terminal for this mount by
   * design: the range and role controls live INSIDE the suppressed subtree,
   * so there is no affordance to retry with, and 403 here is a property of
   * the viewer's role rather than a transient fault. `setForbidden(false)` on
   * each load still matters: it keeps a single 403 from poisoning a later
   * successful fetch on the same mount, e.g. one triggered by a role or range
   * change that raced it.
   */
  if (forbidden) return null;

  const count = (v: number | undefined) => (v ?? 0).toLocaleString();
  const refreshedLabel = rollupRefreshedAt ? formatDayTime(rollupRefreshedAt) : null;

  const reach: Array<MetricItem | false> = [
    // `data === null` is the FIRST LOAD, where `meta` is absent and every
    // derived flag is therefore false. Without it, `=== true` removed this
    // figure until the response arrived: a 4th figure popping into a
    // 3-figure row, and loading made indistinguishable from a server too old
    // to answer.
    (data === null || schemaCurrent) && {
      label: 'Candidates',
      value: count(t?.candidates_total),
      context: 'Entered in this range',
      loading,
    },
    { label: 'Dialled', value: count(t?.dialed), context: 'At least one call', loading },
    {
      label: 'Reached',
      value: count(t?.connected),
      context: 'Machines can count',
      loading,
    },
    {
      label: 'Connect rate',
      value: pctLabel(pct(t?.connected ?? 0, t?.dialed ?? 0)),
      // Both operands are the two figures immediately to the left, so a
      // reader can reproduce this number. Previously the neighbours were
      // ATTEMPT-level counts and dividing them gave a different, equally
      // plausible-looking answer.
      context: 'Reached ÷ dialled',
      loading,
    },
  ];

  const advanceRate = data?.conversions.hr_advance_rate;

  return (
    <section className={cx('mt-8', className)} aria-labelledby="screening-kpis-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <SectionHeader
          id="screening-kpis-heading"
          title="Screening performance"
          description="Who we reached, what screening concluded and what the team did next."
        />
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          {roles.length > 0 && (
            <label className="block w-full sm:w-56">
              <span className="sr-only">Filter by agent</span>
              <select
                value={roleId}
                onChange={(e) => setRoleId(e.target.value)}
                className={cx(controlClass, 'control-select h-11 text-[13px]')}
              >
                <option value="">All agents</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {agentLabels.get(r.id) ?? r.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div role="group" aria-label="Time range" className="glass-sunken inline-flex rounded-[12px] p-1">
            {RANGE_OPTIONS.map((opt) => (
              <button
                key={opt.days}
                type="button"
                aria-pressed={rangeDays === opt.days}
                onClick={() => setRangeDays(opt.days)}
                className={cx(
                  // 44px on a phone: this panel is glanced at on a phone more
                  // than anything else here. 36px once there is a pointer.
                  'min-h-11 rounded-[9px] px-3 text-[13px] font-medium transition-[background-color,color,box-shadow] duration-150 ease-out sm:min-h-9',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-info',
                  rangeDays === opt.days
                    ? 'bg-white text-ink shadow-pill'
                    : 'text-ink-secondary hover:text-ink',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <ErrorPanel
          className="mt-4"
          message={`Screening metrics unavailable. ${error}`}
          onRetry={() => void load()}
        />
      )}

      {!error && neverComputed && (
        <InlineNotice tone="warning" className="mt-4">
          These figures have not been calculated yet. Everything below reads zero until the first
          roll-up runs, which is not the same as nothing having happened.
        </InlineNotice>
      )}

      {/* One status line, three independent facts. Each is its own sentence so
          one failing (the freshness probe) never takes another with it: the
          frozen-days warning was once nested inside the freshness sentence and
          vanished whenever the probe failed, though how far back the roll-up
          reaches has nothing to do with whether we could read when it ran. */}
      {!error && data !== null && (
        <p className="mt-3 text-[12px] leading-5 text-ink-secondary">
          {!neverComputed && refreshedLabel && (
            <span>
              Figures last recalculated {refreshedLabel}. The last day or two are still filling in.{' '}
            </span>
          )}
          {/* "Unknown" must not render as silence: the reader cannot tell it
              from a deliberate omission. */}
          {!freshnessKnown && (
            <span>
              We could not check when these figures were last recalculated, so they may be older
              than they look.{' '}
            </span>
          )}
          {staleBeyondDays !== null && rangeDays > staleBeyondDays && (
            <span>
              Days older than {staleBeyondDays} are no longer recalculated, so the start of this
              range is frozen at its last update.
            </span>
          )}
        </p>
      )}

      {!error && data !== null && !schemaCurrent && (
        <InlineNotice tone="warning" className="mt-3">
          {meta
            ? 'This server is running an older database version, so candidate totals and team-decision figures are unavailable. They are hidden rather than shown as zero.'
            : 'This page is newer than the server it is talking to, so candidate totals and team-decision figures are unavailable. They are hidden rather than shown as zero, and will appear once the update finishes rolling out.'}
        </InlineNotice>
      )}

      {!error && (
        <div className="mt-4 grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <GlassPanel padding="none" className="overflow-hidden">
            <div className="divide-y divide-glass-ring">
              <MetricStrip
                layout="aside"
                columns={4}
                bleed
                label="Reach"
                description="Getting to the candidate."
                items={reach}
                className={ROW}
              />

              <MetricStrip
                layout="aside"
                columns={4}
                bleed
                label="Call volume"
                description="Dials, not people: one person can be called often."
                items={[
                  { label: 'Call attempts', value: count(t?.attempts_total), loading },
                  { label: 'Connects', value: count(t?.connects_total), loading },
                ]}
                className={ROW}
              />

              <MetricStrip
                layout="aside"
                columns={4}
                bleed
                label="Conversation"
                description={
                  loading || !t
                    ? 'What happened on the call.'
                    : `What happened, for the ${t.dialed.toLocaleString()} dialled.`
                }
                items={[
                  { label: 'Answered', value: count(t?.answered_ge1), context: 'Gave a real answer', loading },
                  {
                    label: 'No answers',
                    value: count(derived?.connectedNoAnswer),
                    context: 'Picked up only',
                    loading,
                  },
                  { label: 'Never reached', value: count(derived?.neverConnected), context: 'Never picked up', loading },
                ]}
                className={ROW}
              >
                {!loading && t && countsDisagree && (
                  <InlineNotice tone="warning" role="none" className="mt-2">
                    More people answered a question than we recorded as reached, so the{' '}
                    {t.dialed.toLocaleString()} dialled cannot be split cleanly. Treat this row as
                    approximate.
                  </InlineNotice>
                )}
              </MetricStrip>

              <MetricStrip
                layout="aside"
                columns={4}
                bleed
                label="Screening decision"
                description={
                  loading || !t
                    ? 'What the scorecard concluded.'
                    : `Scorecard verdicts, for ${t.scored.toLocaleString()} screened.`
                }
                items={[
                  { label: 'Qualified', value: count(t?.qualified), tone: 'success', loading },
                  { label: 'Disqualified', value: count(t?.disqualified), tone: 'danger', loading },
                  { label: 'Needs review', value: count(derived?.needsReview), tone: 'warning', context: 'On hold or no verdict', loading },
                ]}
                className={ROW}
              />

              {/* `data === null` included: `hr_tracking_configured` is false for
                  every tenant today, so without it EVERY load renders three
                  skeleton figures and then replaces them with this notice: the
                  same content-jump the DashboardPage role gate exists to avoid. */}
              {data === null || hrUnavailable ? (
                <div className={cx(ROW, 'lg:grid lg:grid-cols-[9rem_minmax(0,1fr)] lg:gap-x-5')}>
                  <h3 className="mb-2 text-[13px] font-semibold leading-5 text-ink lg:mb-0 lg:pt-3">
                    Team decision
                  </h3>
                  <InlineNotice tone="info" className="lg:my-2">
                    {!meta
                      ? 'Not available yet. This page is newer than the server it is talking to; the figures will appear once the update finishes rolling out.'
                      : !schemaCurrent
                        ? 'Not available on this database version. These figures are hidden rather than shown as zero.'
                        : 'Not tracked yet. Reporting what the team did after screening needs each candidate’s Ashby stage to be kept up to date here; today it is only recorded when they are first imported. Until that is connected these numbers could only read zero, which is not the same as nobody being advanced.'}
                  </InlineNotice>
                </div>
              ) : (
                <MetricStrip
                  layout="aside"
                  columns={4}
                  bleed
                  label="Team decision"
                  description="What the team did next."
                  footnote={
                    t && !loading
                      ? [
                          `${t.hr_awaiting.toLocaleString()} screened ${t.hr_awaiting === 1 ? 'candidate is' : 'candidates are'} still waiting for a first look, not counted as rejected.`,
                          t.hr_unknown > 0
                            ? `${t.hr_unknown.toLocaleString()} more cannot be tracked in Ashby yet.`
                            : '',
                        ]
                          .filter(Boolean)
                          .join(' ')
                      : undefined
                  }
                  items={[
                    {
                      label: 'Advanced',
                      value: count(t?.hr_qualified),
                      context: 'At Reference check',
                      loading,
                    },
                    {
                      label: 'Not advanced',
                      value: count(t?.hr_disqualified),
                      context: 'At another stage',
                      loading,
                    },
                    {
                      label: 'Advance rate',
                      value: pctLabel(advanceRate == null ? null : Math.round(advanceRate * 100)),
                      // A JS string holding the character itself. This was a
                      // JSX attribute string holding a unicode ESCAPE, and JSX
                      // attribute strings do not process escapes: the page
                      // printed the six characters of the escape instead.
                      context: 'Advanced ÷ decided',
                      loading,
                    },
                  ]}
                  className={ROW}
                />
              )}
            </div>

            {/* The stated fact, not this window's timestamp. `data.refreshed_at`
                is the newest row IN RANGE, so a quiet week made the closing
                note announce that the figures had never been calculated. */}
            <MetricNotes neverComputed={neverComputed} rangeDays={rangeDays} />
          </GlassPanel>

          <GlassPanel as="section" aria-labelledby="screening-trends-heading">
            <h3 id="screening-trends-heading" className="text-[15px] font-semibold tracking-[-0.01em] text-ink">
              By day
            </h3>
            <p className="mt-0.5 text-[13px] leading-5 text-ink-tertiary">
              By the day each candidate entered.
            </p>
            <div className="mt-4 space-y-5">
              <div>
                <h4 className="mb-1 text-[13px] font-medium text-ink-secondary">Connect rate</h4>
                <LineChart
                  title="Daily connect rate"
                  data={connectSeries}
                  unit="%"
                  isLoading={loading}
                  height={150}
                  discrete
                  emptyTitle="Nothing to plot yet"
                  emptyHint="No day in this range had anyone dialled."
                />
              </div>
              <div className="border-t border-glass-ring pt-4">
                <h4 className="mb-1 text-[13px] font-medium text-ink-secondary">Screening outcomes</h4>
                <LineChart
                  title="Screening outcomes"
                  series={[
                    { name: 'Qualified', data: qualifiedSeries, color: QUALIFIED_COLOUR },
                    { name: 'Disqualified', data: disqualifiedSeries, color: DISQUALIFIED_COLOUR },
                  ]}
                  unit="%"
                  isLoading={loading}
                  height={150}
                  discrete
                  emptyTitle="Nothing to plot yet"
                  emptyHint="No day in this range had anyone screened."
                />
              </div>
            </div>
            <p className="mt-4 text-[12px] leading-4 text-ink-tertiary">
              Days with nobody dialled or screened are left out rather than drawn as 0%, so
              neighbouring points are not always neighbouring days.
            </p>
          </GlassPanel>
        </div>
      )}
    </section>
  );
}

/** Padding of one report row inside the scoreboard panel. */
const ROW = 'px-4 py-3 sm:px-5 lg:py-1';

/**
 * How every number above is calculated, in the reader's language.
 *
 * Collapsed by default so it never competes with the numbers, but present on
 * the page rather than in a wiki: the moment someone doubts a figure is the
 * moment they need the definition, and they will not go looking for it. It
 * is the last row of the scoreboard panel, not a panel of its own.
 */
function MetricNotes({
  neverComputed,
  rangeDays,
}: {
  /**
   * Deliberately NOT derived from a timestamp here. A null `refreshed_at` means
   * "we were not told", which covers an API too old to send `meta` as well as a
   * roll-up that has genuinely never run, and only the second of those may be
   * announced as such. The caller already knows which; this takes the answer.
   */
  neverComputed: boolean;
  rangeDays: number;
}) {
  const rows: Array<[string, string]> = [
    [
      'Candidates',
      `Everyone who entered the pipeline in the last ${rangeDays} days, counted on the day they entered. Days run midnight to midnight UTC (5:30am IST), so somebody who arrived before 5:30am appears under the previous day. The most recent days are still filling in: someone who arrived this morning has not been called yet, so today always looks worse than it will end up.`,
    ],
    [
      'Call attempts',
      'Every dial placed to the people who entered in this range, including dials placed long after they entered, and excluding dials placed during this range to people who entered earlier. Higher than connects by design, and it will not reconcile against a phone bill for the same dates.',
    ],
    [
      'Connects',
      'Call attempts that were picked up. This counts dials, not people: one candidate called three times can contribute three attempts. Do not divide it by Candidates.',
    ],
    ['Dialled', 'Candidates we attempted at least one call to.'],
    ['Reached', 'Candidates where a call was answered. An answering machine can look like an answer, so treat this as an upper bound.'],
    [
      'Connect rate',
      'Candidates we reached ÷ candidates we dialled. Shown as “—” when nobody was dialled yet, because a rate with no denominator is unknown rather than zero.',
    ],
    [
      'Answered',
      'Reached a person and got at least one usable answer to a screening question.',
    ],
    [
      'No answers',
      'The call was answered but produced no usable answer to a screening question. This bucket is broader than a bad line: it also holds people who declined consent, opted out, hung up during the intro, and answering machines. Check the call outcomes before concluding it is a telephony problem. It is calculated by subtraction, and is shown as 0 rather than a negative number if the two underlying counts ever disagree.',
    ],
    ['Never reached', 'We dialled and never reached a person across every attempt.'],
    ['Qualified', 'The automated scorecard recommended advancing this candidate.'],
    ['Disqualified', 'The automated scorecard recommended rejecting this candidate.'],
    [
      'Needs review',
      'The scorecard put the candidate on hold, or could not produce a recommendation at all. These need a human: they are neither qualified nor rejected.',
    ],
    [
      'Advanced',
      'Screened candidates currently sitting at the Reference check stage in Ashby. Current stage, not history: someone promoted beyond Reference check stops being counted here.',
    ],
    [
      'Not advanced',
      'Screened candidates whose Ashby stage is now neither the screening stage nor Reference check. It is where they are, not proof of a decision, and it includes anyone promoted past Reference check, so somebody you hired is counted here rather than under “Advanced”. Only counted when their current stage is actually known to us, so an unconfigured job never lands here.',
    ],
    [
      'Still waiting for the team',
      'Screened candidates whose Ashby stage is still the screening stage. Deliberately not counted as rejected: if they were, the rejection rate would climb every time screening got faster. Only counted when their current stage is actually known to us.',
    ],
    [
      'Advance rate',
      'Advanced ÷ (advanced + not advanced). Only over candidates the team has actually decided on, so neither an untouched backlog nor an unconfigured job can move it. This is NOT a measure of agreement with the screening bot: it never looks at what the bot recommended.',
    ],
    [
      'By day',
      'Each point is one day’s rate among the candidates who entered that day. Days with no denominator (nobody dialled, nobody screened) are left out, never drawn as 0%.',
    ],
  ];

  return (
    <details className="group border-t border-glass-ring">
      <summary
        className={cx(
          'flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 text-[13px] font-medium text-ink sm:px-5',
          'transition-colors duration-150 ease-out hover:bg-ink/[0.025] focus:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--info)]',
          '[&::-webkit-details-marker]:hidden',
        )}
      >
        How these numbers are calculated
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4 shrink-0 text-ink-tertiary transition-transform duration-200 ease-out group-open:rotate-180"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </summary>
      <div className="disclosure-body px-4 pb-5 sm:px-5">
        <p className="max-w-prose text-[13px] leading-5 text-ink-secondary">
          Every figure is a direct count from screening records; nothing is estimated. A candidate
          is counted on the day they entered the pipeline, so moving the date range changes which
          people are included, not how they were measured.
        </p>
        <dl className="mt-4 grid grid-cols-1 gap-x-8 gap-y-3 md:grid-cols-2">
          {rows.map(([term, def]) => (
            <div key={term}>
              <dt className="text-[13px] font-medium text-ink">{term}</dt>
              <dd className="mt-0.5 text-[13px] leading-5 text-ink-secondary">{def}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-[12px] leading-4 text-ink-secondary">
          {neverComputed
            ? 'These figures have not been calculated yet: every number above reads zero until the first refresh runs.'
            : 'Figures refresh periodically, so a call from the last few minutes may not be included yet.'}
        </p>
      </div>
    </details>
  );
}
