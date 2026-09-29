/**
 * HELLO Talent Workspace — recruiter business dashboard (Lane 3).
 *
 * Every number, bar, queue row and CTA here is (a) derived from existing,
 * real API responses (nothing is fabricated) and (b) a real accessible
 * link/control that navigates to the matching, URL-addressable,
 * visibly-represented filter on the Candidates page. Deep links and browser
 * back/forward therefore work end-to-end.
 *
 *   - Pipeline figures + stages ← GET /api/candidates (viewer+), by status.
 *       Each → /candidates?status=… (drill-down).
 *   - Completion                ← decided ÷ considered, from the same statuses.
 *   - Candidates added          ← candidates.created_at per day (all roles).
 *   - Assessments               ← GET /api/candidates/summary (server aggregate).
 *   - Prioritized work          ← GET /api/notifications (interviewer+), joined
 *                                 to candidate names from the same load (no N+1).
 *   - Recent candidates         ← GET /api/candidates (already newest-first).
 *
 * STRUCTURE. The page used to be five bands of identical glass cards (18 of
 * them), three charts and two donuts: 4,000px on a laptop, 15,000px on a
 * phone. It now reads top to bottom as the work does:
 *
 *   1. the four pipeline figures, largest, on one surface: the hero;
 *   2. where everyone is (stages as bars), how intake is moving, and what
 *      the assessments say, side by side;
 *   3. the screening scoreboard (its own component, one report panel);
 *   4. the things to act on: recent candidates, queued work, phone calls.
 *
 * Surface language: the glass system (docs/design/hello-glass-design-system.md).
 * One `GlassPanel` per logical group, hairlines inside, no card per number.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';
import type { Candidate, CandidatesSummary, MeResponse, NotificationIntent } from '../types';
import {
  Button,
  buttonClass,
  ChartCard,
  EmptyPanel,
  ErrorPanel,
  GlassPanel,
  InlineNotice,
  LoadingPanel,
  PageHeader,
  ScrollArea,
  SectionHeader,
  StatusBadge,
} from '../components/design';
import type { StatusTone } from '../components/design';
import { MetricStrip } from '../components/design/MetricStrip';
import { BarList, LineChart } from '../components/charts';
import type { BarListDatum, BarTone } from '../components/charts';
import { countPerDay, formatDay, formatDayTime } from '../components/charts/dates';
import { ScreeningKpis } from '../components/dashboard/ScreeningKpis';
import {
  candidateStatusLabel,
  candidateStatusTone,
  candidateFunnel,
  candidatesHref,
  normalizeStatus,
  recommendationLabel,
  RECOMMENDATION_ORDER,
} from '../components/talent';
import { humanizeEnum } from '../lib/humanize';
import { addIstDays, IST_TIME_ZONE, istDayStartUtcIso, istToday } from '../lib/ist-datetime';
import type { PhoneCalendarResponse } from '../types';

const INTENT_KIND_META: Record<string, { title: string; tone: StatusTone }> = {
  assessment_ready: { title: 'Screening ready for review', tone: 'info' },
  appeal_resolved: { title: 'Appeal resolved, review the outcome', tone: 'success' },
  quota_warning: { title: 'Session quota nearing its limit', tone: 'warning' },
};

const APPOINTMENT_LABELS: Record<string, string> = {
  scheduled: 'Scheduled',
  confirmed: 'Confirmed',
};

/** A recommendation's own meaning, so its bar is coloured by it. */
const RECOMMENDATION_TONE: Record<string, BarTone> = {
  advance: 'success',
  hold: 'warning',
  reject: 'danger',
};

/** A name that opens its record: ink, the accent on hover, never a brand utility. */
const nameLinkClass =
  'rounded-sm font-medium text-ink underline-offset-4 transition-colors duration-150 ease-out hover:text-info hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-info';

export function DashboardPage() {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [intents, setIntents] = useState<NotificationIntent[] | null>(null);
  const [summary, setSummary] = useState<CandidatesSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [phoneSchedule, setPhoneSchedule] = useState<PhoneCalendarResponse | null>(null);
  const [phoneScheduleError, setPhoneScheduleError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [intentsError, setIntentsError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    setCandidates(null);
    setMe(null);
    setIntents(null);
    setSummary(null);
    setSummaryError(null);
    setPhoneSchedule(null);
    setPhoneScheduleError(null);
    setIntentsError(null);

    // Aggregate assessment metrics (viewer+, owner-scoped server-side).
    api
      .getCandidatesSummary()
      .then(setSummary)
      .catch((e: ApiError) => setSummaryError(e.message));

    api
      .getMe()
      .then((nextMe) => {
        setMe(nextMe);
        // Intent data is role-gated; only fetch what the caller can read so
        // the page never makes a doomed 403 call.
        if (nextMe.role !== 'viewer') {
          api
            .listNotificationIntents()
            .then((r) => setIntents(r.intents))
            .catch((e: ApiError) => setIntentsError(e.message));

          // The dashboard only asks for the schedule after the authoritative
          // role response says this account may read it. Viewers therefore
          // never make a phone-calendar request, even transiently.
          const from = istDayStartUtcIso(istToday());
          const to = istDayStartUtcIso(addIstDays(istToday(), 7));
          api
            .getPhoneCalendar(from, to)
            .then(setPhoneSchedule)
            .catch((e: ApiError) => setPhoneScheduleError(e.message));
        }
      })
      .catch((e: ApiError) => setLoadError(e.message));

    api
      .listCandidates()
      .then(setCandidates)
      .catch((e: ApiError) => setLoadError(e.message));
  }, []);

  useEffect(load, [load]);

  const stages = useMemo<BarListDatum[]>(
    () =>
      candidates
        ? candidateFunnel(candidates).map((f) => ({
            label: f.label,
            value: f.value,
            href: candidatesHref({ statuses: [f.status] }),
            title: f.status,
          }))
        : [],
    [candidates],
  );

  if (loadError) {
    return <ErrorPanel message={loadError} onRetry={load} />;
  }
  if (!candidates || !me) {
    return <LoadingPanel label="Loading dashboard…" />;
  }

  const byStatus = (statuses: string[]) =>
    candidates.filter((c) => statuses.includes(normalizeStatus(c.status))).length;

  const total = candidates.length;
  const awaiting = byStatus(['new']);
  const inScreening = byStatus(['queued', 'screening']);
  const awaitingDecision = byStatus(['screened']);
  const decided = byStatus(['advanced', 'rejected']);
  const considered = candidates.filter(
    (c) => normalizeStatus(c.status) !== 'consent_declined',
  ).length;
  const completionPct = considered > 0 ? Math.round((decided / considered) * 100) : 0;

  const intakeTrend = countPerDay(candidates);

  return (
    <div className="pb-4">
      <PageHeader
        eyebrow="Talent workspace"
        title="Dashboard"
        description="Your pipeline from live data. Every figure opens the matching candidates."
        actions={
          <>
            <Button variant="secondary" onClick={load}>
              Refresh
            </Button>
            {me.role === 'admin' && (
              /*
                Session operations, recording integrity and quotas live in
                Mission Control. A real <Link> in the header (keyboard
                reachable, open-in-new-tab friendly) replaces the trailing
                paragraph that used to carry the same destination.
              */
              <Link to="/mission-control" className={buttonClass('secondary', 'md')}>
                Mission Control
                <ArrowIcon />
              </Link>
            )}
          </>
        }
      />

      {/* The hero: the four figures a recruiter opens the page for, largest,
          on one surface. Each is a drill-down link to exactly those people. */}
      <GlassPanel padding="none" className="mt-6 overflow-hidden">
        <MetricStrip
          label="Pipeline"
          hideLabel
          headingLevel={2}
          size="hero"
          items={[
            {
              label: 'Candidates',
              value: total.toLocaleString(),
              context: 'In the pipeline',
              href: candidatesHref(),
              ariaLabel: `${total} candidates in pipeline. View all candidates.`,
            },
            {
              label: 'Awaiting screening',
              value: awaiting.toLocaleString(),
              context: 'New, not yet screened',
              href: candidatesHref({ statuses: ['new'] }),
              ariaLabel: `${awaiting} candidates awaiting screening. View them.`,
            },
            {
              label: 'In screening',
              value: inScreening.toLocaleString(),
              context: 'Queued or on a call',
              href: candidatesHref({ statuses: ['queued', 'screening'] }),
              ariaLabel: `${inScreening} candidates in screening. View them.`,
            },
            {
              label: 'Awaiting decision',
              value: awaitingDecision.toLocaleString(),
              context: 'Screened, ready to review',
              href: candidatesHref({ statuses: ['screened'] }),
              ariaLabel: `${awaitingDecision} candidates awaiting a decision. Review them.`,
            },
          ]}
        />
      </GlassPanel>

      <div className="mt-6 grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
        <ChartCard
          title="Pipeline by stage"
          meta={<CompletionMeta completionPct={completionPct} />}
          // Each stage is a link to exactly those candidates.
          description={`${decided} of ${considered} decided (advanced or rejected).`}
        >
          {/* Stage order, not size order: the pipeline is a sequence the
              reader already knows, and ranking it would scramble it. */}
          <BarList
            title="Pipeline by stage"
            data={stages}
            order="none"
            categoryHeader="Stage"
            valueHeader="Candidates"
            linkHint="View these candidates."
            emptyTitle="No candidates"
            emptyHint="Stages will appear here once candidates are added."
          />
        </ChartCard>

        <ChartCard title="Candidates added" description="Per day, last 14 days, all roles.">
          <LineChart
            title="Candidates added per day"
            data={intakeTrend}
            unit="candidates"
            isLoading={false}
            height={200}
            emptyTitle="No candidates yet"
            emptyHint="New candidates will appear here as they are added."
          />
        </ChartCard>

        <AssessmentsPanel summary={summary} error={summaryError} onRetry={load} />
      </div>

      {/* Screening scoreboard (0098 + /api/funnel/summary). Placed directly
          under the pipeline: this is the block the HR head opens the page
          for, so it sits above the operational queues rather than below.

          Gated on role HERE, not only by the panel's own 403 handling. The
          route is interviewer-and-above, so mounting it for a viewer renders
          a panel of skeletons, waits for the 403, then removes all of it:
          content jumping up under a cursor that may already be mid-click.
          This page's contract (see the header) is that it never makes a
          doomed call. */}
      {me.role !== 'viewer' && <ScreeningKpis />}

      <div className="mt-8 grid grid-cols-1 items-start gap-6 lg:grid-cols-2 xl:grid-cols-3">
        <RecentCandidates candidates={candidates} />
        <ActionQueue
          intents={intents}
          intentsError={intentsError}
          candidates={candidates}
          viewer={me.role === 'viewer'}
        />
        {me.role !== 'viewer' && (
          <PhoneScheduleCard data={phoneSchedule} error={phoneScheduleError} />
        )}
      </div>
    </div>
  );
}

function ArrowIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5 text-ink-tertiary"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M7 17 17 7M8 7h9v9" />
    </svg>
  );
}

/* ── Completion (beside the stage bars' title) ──────────────────────── */

/**
 * Decided ÷ considered, as a small ring beside the title. The count it is
 * made of ("8 of 23 decided") is the panel's description, so the reader has
 * the fraction and the figure together. The ring is decorative; the text
 * carries the number.
 */
function CompletionMeta({ completionPct }: { completionPct: number }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-ink/[0.05] py-0.5 pl-1 pr-2 text-[12px] font-medium tabular-nums text-ink-secondary">
      <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4 -rotate-90">
        <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2.5" className="stroke-ink/[0.1]" />
        <circle
          cx="8"
          cy="8"
          r={r}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          className="stroke-info"
          strokeDasharray={`${(completionPct / 100) * c} ${c}`}
        />
      </svg>
      {completionPct}% complete
    </span>
  );
}

/* ── Assessments (server-side aggregate; truthful) ─────────────────── */

function AssessmentsPanel({
  summary,
  error,
  onRetry,
}: {
  summary: CandidatesSummary | null;
  error: string | null;
  onRetry: () => void;
}) {
  const dist = summary?.recommendation_distribution;
  const data: BarListDatum[] = dist
    ? RECOMMENDATION_ORDER.filter((r) => dist[r] > 0).map((r) => ({
        label: recommendationLabel(r),
        value: dist[r],
        href: candidatesHref({ recommendations: [r] }),
        tone: RECOMMENDATION_TONE[r],
        title: r,
      }))
    : [];
  const assessedTotal = data.reduce((s, d) => s + d.value, 0);
  const hasAvg = summary != null && summary.average_score != null;

  return (
    <ChartCard
      title="Assessments"
      description="The latest assessment of each candidate."
    >
      {error ? (
        <ErrorPanel compact className="min-h-40" message={error} onRetry={onRetry} />
      ) : summary == null ? (
        <LoadingPanel compact label="Loading assessments…" />
      ) : (
        <>
          <Link
            to={candidatesHref({ assessed: true })}
            aria-label={
              hasAvg
                ? `Average assessment score ${summary.average_score} across ${summary.assessed_count} assessed candidates. View them.`
                : 'View assessed candidates.'
            }
            className="group -mx-2 block rounded-[12px] px-2 py-1.5 transition-colors duration-150 ease-out hover:bg-ink/[0.025] focus:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--info)]"
          >
            <p className="text-[13px] font-medium text-ink-secondary">Average score</p>
            {hasAvg ? (
              <p className="mt-1 text-2xl font-semibold leading-8 tracking-[-0.02em] tabular-nums text-ink">
                {summary.average_score}
                <span className="ml-1 text-[13px] font-normal tracking-normal text-ink-tertiary">
                  / 100 across {summary.assessed_count} assessed
                </span>
              </p>
            ) : (
              <p className="mt-1 text-[13px] text-ink-tertiary">No assessments yet</p>
            )}
          </Link>

          <div className="mt-3 border-t border-glass-ring pt-3">
            <h3 className="mb-1 text-[13px] font-medium text-ink-secondary">Recommendation</h3>
            {assessedTotal === 0 ? (
              <EmptyPanel
                compact
                title="No assessments yet"
                hint="Recommendation counts appear once candidates are assessed."
              />
            ) : (
              <BarList
                title="Recommendation distribution"
                data={data}
                order="none"
                categoryHeader="Recommendation"
                valueHeader="Candidates"
                linkHint="View these candidates."
              />
            )}
          </div>
        </>
      )}
    </ChartCard>
  );
}

/* ── Recent candidates (API returns newest-first) ───────────────────── */

const RECENT_LIMIT = 5;

function RecentCandidates({ candidates }: { candidates: Candidate[] }) {
  const recent = candidates.slice(0, RECENT_LIMIT);

  return (
    <GlassPanel as="section" aria-label="Recent candidates">
      <SectionHeader
        title="Recent candidates"
        meta={
          candidates.length > 0 ? (
            <span className="text-[13px] tabular-nums text-ink-tertiary">{candidates.length} total</span>
          ) : undefined
        }
        actions={
          candidates.length > recent.length ? (
            <Link to="/candidates" className={buttonClass('ghost', 'md')}>
              View all
            </Link>
          ) : undefined
        }
        className="mb-2"
      />
      {candidates.length === 0 ? (
        <EmptyPanel
          compact
          title="No candidates yet"
          hint="Upload a resume from the Candidates page to start your pipeline."
          action={
            <Link to="/candidates" className={buttonClass('secondary', 'md')}>
              Go to Candidates
            </Link>
          }
        />
      ) : (
        <ul role="list" aria-label="Recent candidates, newest first" className="divide-y divide-glass-ring">
          {recent.map((candidate) => {
            const added = formatDay(candidate.created_at);
            const meta = [
              candidate.experience_years != null ? `${candidate.experience_years} yr experience` : null,
              added ? `Added ${added}` : null,
            ].filter(Boolean);
            return (
              <li key={candidate.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <Link to={`/candidates/${candidate.id}`} className={`block truncate text-sm ${nameLinkClass}`}>
                    {candidate.name || 'Unnamed'}
                  </Link>
                  {meta.length > 0 && (
                    <p className="truncate text-[13px] tabular-nums text-ink-tertiary">{meta.join(' · ')}</p>
                  )}
                </div>
                <StatusBadge tone={candidateStatusTone(candidate.status)} className="shrink-0">
                  {candidateStatusLabel(candidate.status)}
                </StatusBadge>
              </li>
            );
          })}
        </ul>
      )}
    </GlassPanel>
  );
}

/* ── Prioritized work queue (real notification intents, no fabrication) ─ */

const QUEUE_LIMIT = 8;
/** Beyond this many rows the queue is bounded instead of running down the page. */
const QUEUE_SCROLL_AFTER = 5;

function ActionQueue({
  intents,
  intentsError,
  candidates,
  viewer,
}: {
  intents: NotificationIntent[] | null;
  intentsError: string | null;
  candidates: Candidate[];
  viewer: boolean;
}) {
  const candidateById = useMemo(
    () => new Map(candidates.map((candidate) => [candidate.id, candidate])),
    [candidates],
  );

  const shown = intents ? intents.slice(0, QUEUE_LIMIT) : [];

  const list = (
    <ul role="list" className="divide-y divide-glass-ring">
      {shown.map((intent) => {
        const meta = INTENT_KIND_META[intent.kind] ?? {
          title: humanizeEnum(intent.kind),
          tone: 'neutral' as StatusTone,
        };
        const candidate = intent.candidate_id
          ? candidateById.get(intent.candidate_id)
          : undefined;
        return (
          <li key={intent.id} className="py-2.5">
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 truncate text-sm">
                {candidate ? (
                  <Link to={`/candidates/${candidate.id}`} className={nameLinkClass}>
                    {candidate.name || 'Unnamed candidate'}
                  </Link>
                ) : (
                  <span className="text-ink-secondary">
                    {intent.candidate_id ? 'Candidate no longer available' : 'Workspace-wide'}
                  </span>
                )}
              </p>
              <span className="shrink-0 text-[12px] tabular-nums text-ink-tertiary">
                {formatDayTime(intent.created_at) ?? 'Time unavailable'}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <StatusBadge tone={meta.tone}>
                <span title={intent.kind}>{meta.title}</span>
              </StatusBadge>
              {intent.consent_verified && (
                <StatusBadge tone="success" dot={false}>
                  Consent verified
                </StatusBadge>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );

  return (
    <GlassPanel as="section" aria-label="Action queue">
      <SectionHeader title="Prioritized work" className="mb-2" />
      {viewer ? (
        <p className="py-6 text-center text-sm text-ink-tertiary">
          Action items require interviewer or admin access.
        </p>
      ) : intents === null && !intentsError ? (
        <LoadingPanel compact label="Loading action items…" />
      ) : intentsError ? (
        <ErrorPanel compact message={intentsError} />
      ) : shown.length === 0 ? (
        <EmptyPanel compact title="You're all caught up. No pending items." />
      ) : shown.length > QUEUE_SCROLL_AFTER ? (
        <ScrollArea maxHeight="19rem" label="Prioritized work">
          {list}
        </ScrollArea>
      ) : (
        list
      )}
    </GlassPanel>
  );
}

/* ── Phone schedule visibility ──────────────────────────────────────── */

function PhoneScheduleCard({
  data,
  error,
}: {
  data: PhoneCalendarResponse | null;
  error: string | null;
}) {
  const live = data?.appointments.filter(
    (appointment) => appointment.status === 'scheduled' || appointment.status === 'confirmed',
  ) ?? [];
  const now = Date.now();
  const upcoming = live.filter((appointment) => Date.parse(appointment.starts_at) >= now);
  const overdue = live.filter((appointment) => Date.parse(appointment.starts_at) < now);
  const next = upcoming.slice(0, 3);

  return (
    <GlassPanel as="section" aria-labelledby="phone-schedule-heading">
      <SectionHeader
        id="phone-schedule-heading"
        title="Phone schedule"
        description="Next seven days, in IST."
        actions={
          <Link to="/phone-calendar" className={buttonClass('secondary', 'md')}>
            Open calendar
          </Link>
        }
        className="mb-3"
      />

      {error ? (
        <InlineNotice tone="warning">
          Phone schedule unavailable. Open the phone calendar to retry.
        </InlineNotice>
      ) : data === null ? (
        <LoadingPanel compact label="Loading schedule…" />
      ) : !data.enabled ? (
        <InlineNotice tone="neutral">
          Phone screening is turned off. No appointments were loaded.
        </InlineNotice>
      ) : (
        <>
          <MetricStrip
              label="Appointments"
              hideLabel
              size="compact"
              columns={3}
              bleed
              items={[
                { label: 'Upcoming', value: String(upcoming.length) },
                { label: 'Overdue', value: String(overdue.length), attention: overdue.length > 0 },
                { label: 'All', value: String(data.count), context: 'Any status' },
              ]}
            />
          {data.truncated && (
            <InlineNotice tone="warning" className="mt-3">
              The schedule is larger than this summary window; open the calendar for the full
              bounded view.
            </InlineNotice>
          )}
          {next.length > 0 ? (
            <ul role="list" className="mt-2 divide-y divide-glass-ring border-t border-glass-ring" aria-label="Next phone appointments">
              {next.map((appointment) => (
                <li
                  key={appointment.id}
                  className="flex items-center justify-between gap-3 py-2.5 text-sm"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-ink">
                      {appointment.candidate?.name ?? 'Candidate'}
                    </p>
                    <p className="text-[13px] tabular-nums text-ink-tertiary">
                      {(() => {
                        const when = formatDayTime(appointment.starts_at, { timeZone: IST_TIME_ZONE });
                        return when ? `${when} IST` : 'Time unavailable';
                      })()}
                    </p>
                  </div>
                  <StatusBadge tone="info" className="shrink-0">
                    <span title={appointment.status}>
                      {humanizeEnum(appointment.status, APPOINTMENT_LABELS)}
                    </span>
                  </StatusBadge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-ink-secondary">
              No upcoming appointments in the next seven days.
            </p>
          )}
        </>
      )}
    </GlassPanel>
  );
}
