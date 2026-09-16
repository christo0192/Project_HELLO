/**
 * ScreeningKpis — the screening scoreboard for a non-technical audience.
 *
 * DESIGN INTENT. Eleven numbers presented as eleven equal cards is a wall, and
 * a wall gets skimmed once and never returned to. They are grouped into four
 * bands that each answer one question, in the order the work actually happens:
 *
 *    Reach            did we get to them?
 *    Conversation     did they actually talk to us?
 *    Bot decision     what did the screening conclude?
 *    HR decision      what did the team do about it?
 *
 * Only the four band headings compete for attention; within a band the cards
 * are peers. That is what keeps eleven numbers readable.
 *
 * TRUTHFULNESS RULES, because this is read by people who will make hiring
 * decisions from it and cannot audit the SQL:
 *
 *  - Every card is a direct sum from the stored rollup. Nothing is estimated,
 *    extrapolated or back-filled.
 *  - `hr_awaiting` is shown as a footnote under the HR band rather than folded
 *    into "HR disqualified". Folding it in would make the rejection rate climb
 *    whenever screening got FASTER, which reads exactly like an insight and is
 *    an artefact.
 *  - Rates are suppressed (— rather than 0%) when the denominator is zero. A
 *    "0%" connect rate on a day nobody was dialled is a lie of arithmetic.
 *  - The "how these are calculated" block at the bottom is not decoration; it
 *    is the only way a non-technical reader can tell a real drop from a
 *    definition they misread.
 *
 * Surface language: the glass system, the HR-approved palette, and the shared
 * KpiCard/ChartCard/LineChart primitives — no bespoke chrome.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import type { FunnelDailyRow, FunnelSummaryResponse, Role } from '../../types';
import {
  ChartCard,
  ErrorPanel,
  GlassPanel,
  InlineNotice,
  KpiCard,
  RevealGroup,
  RevealItem,
  SectionHeader,
  cx,
} from '../design';
import { LineChart } from '../charts';

/** Selectable trailing windows. 30 is the default the endpoint already uses. */
const RANGE_OPTIONS = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
] as const;

type RangeDays = (typeof RANGE_OPTIONS)[number]['days'];

/** YYYY-MM-DD `days` before today (UTC), matching the server's own helper. */
function dayOffset(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * A ratio as a whole-number percent, or null when the denominator is zero.
 * Null renders as "—": a rate with no denominator is unknown, not zero.
 */
function pct(num: number, den: number): number | null {
  if (!den || den <= 0) return null;
  return Math.round((num / den) * 100);
}

function pctLabel(value: number | null): string {
  return value === null ? '—' : `${value}%`;
}

/** Short, human day label for a chart axis: "16 Sep". */
function dayLabel(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? ymd
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/**
 * Build a rate series, DROPPING days whose denominator is zero.
 *
 * Exported because this is the rule most easily broken and least visibly
 * tested: asserting it through a rendered ECharts canvas means asserting on a
 * data table that may not exist in jsdom, which silently turns the test into a
 * no-op. A `?? 0` here would plot "unknown" as a hard zero — a weekend with no
 * dials rendering as a connect-rate cliff, indistinguishable from every phone
 * line failing, and directly contradicting the card behaviour above.
 */
export function buildRateSeries(
  rows: FunnelDailyRow[],
  num: (row: FunnelDailyRow) => number,
  den: (row: FunnelDailyRow) => number,
): Array<{ label: string; value: number }> {
  return rows
    .map((row) => ({ label: dayLabel(row.cohort_day), value: pct(num(row), den(row)) }))
    .filter((p): p is { label: string; value: number } => p.value !== null);
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
  const [roleId, setRoleId] = useState<string>('');
  const [data, setData] = useState<FunnelSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Monotonic request id. Click 90 then 7: if the 90-day response lands second
  // it would repaint the panel while the control and the notes both still say
  // "7 days" — 90 days of numbers under a 7-day label, with no error.
  const requestSeq = useRef(0);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
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
   * 0098's fields — and `t.hr_awaiting.toLocaleString()` on `undefined` throws
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
   * The rollup has never been computed. Rendering eleven confident zeros here
   * is the single worst thing this panel could do: "0 candidates" and "not
   * calculated yet" look identical, and the reader has no way to tell.
   */
  const neverComputed = data !== null && data.refreshed_at === null;

  /**
   * HR stage tracking is not wired. When no screened candidate's Ashby stage
   * is observable, the HR cards can only ever be zero — which would read as
   * "the team rejected everyone and has an empty queue" off a configuration
   * gap. Show the band as unconfigured instead of showing false zeros.
   */
  const hrObservable = !!t && (t.hr_qualified + t.hr_disqualified + t.hr_awaiting) > 0;
  const hrUnconfigured = !!t && !hrObservable && t.hr_unknown > 0;

  /**
   * Derived counts. Each is a subtraction of two sums from the same rollup
   * rows, so they cannot disagree with the cards they are derived from.
   */
  const derived = useMemo(() => {
    if (!t) return null;
    return {
      // Connected but never produced a usable answer — reached a human and
      // learned nothing. The number worth acting on.
      connectedNoAnswer: Math.max(0, t.connected - t.answered_ge1),
      // Dialled and never reached a human at all.
      neverConnected: Math.max(0, t.dialed - t.connected),
      // `hold` + `human_review` — the bot declined to decide. Shown so
      // qualified + disqualified + this reconciles against `scored`.
      needsReview: t.on_hold + t.human_review,
    };
  }, [t]);

  /**
   * Rate series with the no-denominator days REMOVED rather than plotted as 0.
   *
   * `?? 0` here was the panel's worst inconsistency: the cards refuse to print
   * "0%" for an unknown rate — the header calls it "a lie of arithmetic" — and
   * the charts then told exactly that lie, at higher visual weight. A weekend
   * with no dials rendered as a connect-rate CLIFF to zero, indistinguishable
   * from every phone line failing. Dropping the point leaves a gap, which is
   * what "we cannot know" should look like.
   */
  const rateSeries = useCallback(
    (num: (row: FunnelDailyRow) => number, den: (row: FunnelDailyRow) => number) =>
      (data ? buildRateSeries(data.series, num, den) : []),
    [data],
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

  const stale = data?.refreshed_at ?? null;

  // Not an error state — this role simply does not have screening metrics.
  if (forbidden) return null;

  return (
    <section className={cx('mt-8', className)} aria-labelledby="screening-kpis-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <SectionHeader
          id="screening-kpis-heading"
          title="Screening performance"
          description="How many people we reached, what the screening concluded, and what the team did next."
        />
        <div className="flex flex-wrap items-center gap-2">
          {roles.length > 0 && (
            <label className="flex items-center gap-2 text-[13px] text-ink-secondary">
              <span className="sr-only">Filter by role</span>
              <select
                value={roleId}
                onChange={(e) => setRoleId(e.target.value)}
                className="glass-sunken rounded-lg px-3 py-1.5 text-[13px] text-ink"
              >
                <option value="">All roles</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div
            role="group"
            aria-label="Time range"
            className="glass-sunken inline-flex rounded-lg p-1"
          >
            {RANGE_OPTIONS.map((opt) => (
              <button
                key={opt.days}
                type="button"
                aria-pressed={rangeDays === opt.days}
                onClick={() => setRangeDays(opt.days)}
                className={cx(
                  'rounded-md px-3 py-1 text-[13px] font-medium transition-colors',
                  rangeDays === opt.days
                    ? 'bg-accent-500 text-white shadow-sm'
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
          These figures have not been calculated yet. Everything below will read
          zero until the first nightly roll-up runs — that is not the same as
          “nothing happened”.
        </InlineNotice>
      )}

      {!error && !neverComputed && data?.refreshed_at && (
        <p className="mt-2 text-[12px] text-ink-secondary">
          Figures last recalculated {new Date(data.refreshed_at).toLocaleString()}. Candidates
          are counted on the day they entered, so the most recent days are still filling in.
        </p>
      )}

      {!error && (
        <>
          <KpiBand title="Reach" hint="Getting to the candidate.">
            <KpiCard
              label="Total candidates"
              value={t?.candidates_total ?? 0}
              hint="In this date range"
              loading={loading}
            />
            <KpiCard
              label="Candidates dialled"
              value={t?.dialed ?? 0}
              hint="At least one call attempted"
              loading={loading}
            />
            <KpiCard
              label="Candidates reached"
              value={t?.connected ?? 0}
              hint="A call was picked up"
              loading={loading}
            />
            <KpiCard
              label="Connect rate"
              value={pct(t?.connected ?? 0, t?.dialed ?? 0) ?? 0}
              formatValue={() => pctLabel(pct(t?.connected ?? 0, t?.dialed ?? 0))}
              // Both operands are the two cards immediately to the left, so a
              // reader can reproduce this number. Previously the neighbours
              // were ATTEMPT-level counts and dividing them gave a different,
              // equally plausible-looking answer.
              hint="Reached ÷ dialled"
              loading={loading}
            />
          </KpiBand>

          <KpiBand
            title="Call volume"
            hint="Dials, not people — one candidate can be called several times."
          >
            <KpiCard
              label="Total call attempts"
              value={t?.attempts_total ?? 0}
              hint="Every dial, including retries"
              loading={loading}
            />
            <KpiCard
              label="Total connects"
              value={t?.connects_total ?? 0}
              hint="Attempts that were picked up"
              loading={loading}
            />
          </KpiBand>

          <KpiBand
            title="Conversation"
            hint={`What happened once they answered. These three add up to the ${(t?.dialed ?? 0).toLocaleString()} candidates dialled.`}
          >
            <KpiCard
              label="Answered questions"
              value={t?.answered_ge1 ?? 0}
              hint="Gave at least one real answer"
              tone="success"
              loading={loading}
            />
            <KpiCard
              label="Connected, no answers"
              value={derived?.connectedNoAnswer ?? 0}
              hint="Picked up but told us nothing"
              tone="warning"
              loading={loading}
            />
            <KpiCard
              label="Never connected"
              value={derived?.neverConnected ?? 0}
              hint="Dialled, never reached"
              tone="danger"
              loading={loading}
            />
          </KpiBand>

          <KpiBand
            title="Screening decision"
            hint={`What the scorecard concluded for the ${(t?.scored ?? 0).toLocaleString()} candidates it screened.`}
          >
            <KpiCard
              label="Bot qualified"
              value={t?.qualified ?? 0}
              hint="Scorecard recommends advancing"
              tone="success"
              loading={loading}
            />
            <KpiCard
              label="Bot disqualified"
              value={t?.disqualified ?? 0}
              hint="Scorecard recommends rejecting"
              tone="danger"
              loading={loading}
            />
            <KpiCard
              label="Needs review"
              value={derived?.needsReview ?? 0}
              hint="On hold, or no recommendation"
              tone="warning"
              loading={loading}
            />
          </KpiBand>

          {hrUnconfigured ? (
            <div className="mt-5">
              <div className="mb-2 flex items-baseline gap-2">
                <h3 className="text-[13px] font-semibold uppercase tracking-wide text-ink-secondary">
                  Team decision
                </h3>
              </div>
              <InlineNotice tone="info">
                Not tracked yet. Reporting what the team did after screening needs the
                Reference check stage linked on the Ashby job. Until then these numbers
                could only ever read zero, which is not the same as &ldquo;nobody was
                advanced&rdquo;.
                {t
                  ? ` ${t.hr_unknown.toLocaleString()} screened ${t.hr_unknown === 1 ? 'candidate is' : 'candidates are'} waiting on that link.`
                  : ''}
              </InlineNotice>
            </div>
          ) : (
            <KpiBand
              title="Team decision"
              hint="What the team did with the screened candidates."
              footnote={
                t
                  ? [
                      `${t.hr_awaiting.toLocaleString()} screened ${t.hr_awaiting === 1 ? 'candidate is' : 'candidates are'} still waiting for a first look \u2014 not counted as rejected.`,
                      t.hr_unknown > 0
                        ? `${t.hr_unknown.toLocaleString()} more cannot be tracked in Ashby yet.`
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' ')
                  : undefined
              }
            >
              <KpiCard
                label="Advanced by the team"
                value={t?.hr_qualified ?? 0}
                hint="Currently at Reference check"
                tone="success"
                loading={loading}
              />
              <KpiCard
                label="Not advanced"
                value={t?.hr_disqualified ?? 0}
                hint="Moved to another stage instead"
                loading={loading}
              />
              <KpiCard
                label="Advance rate"
                value={data?.conversions.hr_advance_rate ?? 0}
                formatValue={() =>
                  pctLabel(
                    data?.conversions.hr_advance_rate == null
                      ? null
                      : Math.round(data.conversions.hr_advance_rate * 100),
                  )
                }
                hint="Advanced \u00f7 decided by the team"
                loading={loading}
              />
            </KpiBand>
          )}

          <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ChartCard
              title="Daily connect rate"
              description="Share of dialled candidates who picked up, by the day they entered the pipeline."
            >
              <LineChart
                title="Daily connect rate"
                data={connectSeries}
                unit="%"
                isLoading={loading}
                height={220}
              />
            </ChartCard>
            <ChartCard
              title="Screening outcomes"
              description="Qualified and disqualified as a share of everyone the bot scored that day."
            >
              <div className="grid grid-cols-1 gap-2">
                <LineChart
                  title="Qualification rate"
                  data={qualifiedSeries}
                  unit="%"
                  isLoading={loading}
                  height={100}
                />
                <LineChart
                  title="Disqualification rate"
                  data={disqualifiedSeries}
                  unit="%"
                  isLoading={loading}
                  height={100}
                />
              </div>
            </ChartCard>
          </div>

          <MetricNotes refreshedAt={stale} rangeDays={rangeDays} />
        </>
      )}
    </section>
  );
}

/**
 * One labelled band of KPI cards. The heading carries the question the band
 * answers; the cards inside are peers, which is what stops eleven numbers
 * reading as a wall.
 */
function KpiBand({
  title,
  hint,
  footnote,
  children,
}: {
  title: string;
  hint?: string;
  footnote?: string;
  children: React.ReactNode;
}) {
  // Without the association the grouping is purely visual: a screen-reader
  // user gets eleven ungrouped numbers, i.e. exactly the wall the bands exist
  // to prevent.
  const bandId = `kpi-band-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`;
  return (
    <div className="mt-5">
      <div className="mb-2 flex items-baseline gap-2">
        <h3
          id={bandId}
          className="text-[13px] font-semibold uppercase tracking-wide text-ink-secondary"
        >
          {title}
        </h3>
        {hint && <p className="text-[12px] text-ink-secondary/80">{hint}</p>}
      </div>
      <div role="group" aria-labelledby={bandId}>
        <RevealGroup className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.isArray(children)
          ? children.map((child, i) => <RevealItem key={i}>{child}</RevealItem>)
          : children}
        </RevealGroup>
      </div>
      {footnote && <p className="mt-2 text-[12px] text-ink-secondary">{footnote}</p>}
    </div>
  );
}

/**
 * How every number above is calculated, in the reader's language.
 *
 * Collapsed by default so it never competes with the numbers, but present on
 * the page rather than in a wiki — the moment someone doubts a figure is the
 * moment they need the definition, and they will not go looking for it.
 */
function MetricNotes({
  refreshedAt,
  rangeDays,
}: {
  refreshedAt: string | null;
  rangeDays: number;
}) {
  const rows: Array<[string, string]> = [
    [
      'Total candidates',
      `Résumés that parsed into a candidate record in the last ${rangeDays} days. A candidate is counted on the day they ENTERED, so the most recent days are still filling in — someone who arrived this morning has not been called yet.`,
    ],
    [
      'Total call attempts',
      'Every dial we placed, including repeat attempts to the same person. Higher than connects by design.',
    ],
    [
      'Total connects',
      'Call attempts that were picked up. This counts DIALS, not people — one candidate called three times can contribute three attempts. Do not divide it by Total candidates.',
    ],
    ['Candidates dialled', 'People we attempted at least one call to.'],
    ['Candidates reached', 'People where a call was answered. An answering machine can look like an answer, so treat this as an upper bound.'],
    [
      'Connect rate',
      'Candidates we reached ÷ candidates we dialled. Shown as “—” when nobody was dialled yet, because a rate with no denominator is unknown rather than zero.',
    ],
    [
      'Answered questions',
      'Reached a person AND got at least one usable answer to a screening question.',
    ],
    [
      'Connected, no answers',
      'The call was answered but produced no usable answer to a screening question. This bucket is broader than a bad line: it also holds people who declined consent, opted out, hung up during the intro, and answering machines. Check the call outcomes before concluding it is a telephony problem.',
    ],
    ['Never connected', 'We dialled and never reached a person across every attempt.'],
    [
      'Bot qualified',
      'The automated scorecard recommended advancing this candidate.',
    ],
    [
      'Bot disqualified',
      'The automated scorecard recommended rejecting this candidate.',
    ],
    [
      'Needs review',
      'The scorecard put the candidate on hold, or could not produce a recommendation at all. These need a human — they are neither qualified nor rejected.',
    ],
    [
      'Advanced by the team',
      'Screened candidates currently sitting at the Reference check stage in Ashby. Current stage, not history — someone promoted beyond Reference check stops being counted here.',
    ],
    [
      'Not advanced',
      'Screened candidates the team has moved to some other stage. Only counted when we can actually see their Ashby stage, so an unconfigured job never lands here.',
    ],
    [
      'Still waiting for the team',
      'Screened candidates still sitting in the AI screening stage, untouched. Deliberately NOT counted as rejected: if they were, the rejection rate would climb every time screening got faster.',
    ],
    [
      'Advance rate',
      'Advanced ÷ (advanced + not advanced). Only over candidates the team has actually decided on, so neither an untouched backlog nor an unconfigured job can move it. This is NOT a measure of agreement with the screening bot — it never looks at what the bot recommended.',
    ],
  ];

  return (
    <GlassPanel className="mt-6 p-5">
      <details>
        <summary className="cursor-pointer list-none text-[13px] font-semibold text-ink">
          <span className="select-none">How these numbers are calculated ▾</span>
        </summary>
        <p className="mt-3 text-[13px] text-ink-secondary">
          Every figure is a direct count from screening records — nothing is estimated. A
          candidate is counted on the day they entered the pipeline, so moving the date range
          changes which people are included, not how they were measured.
        </p>
        <dl className="mt-4 grid grid-cols-1 gap-x-8 gap-y-3 md:grid-cols-2">
          {rows.map(([term, def]) => (
            <div key={term}>
              <dt className="text-[13px] font-medium text-ink">{term}</dt>
              <dd className="mt-0.5 text-[13px] leading-relaxed text-ink-secondary">{def}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-[12px] text-ink-secondary">
          {refreshedAt
            ? 'Figures refresh periodically, so a call from the last few minutes may not be included yet.'
            : 'These figures have not been calculated yet — every number above will read zero until the first roll-up runs.'}
        </p>
      </details>
    </GlassPanel>
  );
}
