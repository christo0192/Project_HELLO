/**
 * HELLO Talent Workspace — recruiter business dashboard (Lane 3).
 *
 * Every number, chart segment, queue row and CTA here is (a) derived from
 * existing, real API responses — nothing is fabricated — and (b) a real
 * accessible link/control that navigates to the matching, URL-addressable,
 * visibly-represented filter on the Candidates page. Deep links and browser
 * back/forward therefore work end-to-end.
 *
 *   - KPIs + screening funnel  ← GET /api/candidates (viewer+), by status.
 *       Each → /candidates?status=… (drill-down).
 *   - Completion              ← decided ÷ considered, from the same statuses.
 *   - Candidate intake trend  ← candidates.created_at per day (all roles).
 *   - Prioritized work queue  ← GET /api/notifications (interviewer+), joined
 *                               to candidate names from the same load (no N+1).
 *   - Recent candidates       ← GET /api/candidates (already newest-first).
 *
 * Deliberately omitted (cannot be shown truthfully from list payloads without
 * per-candidate N+1 fetches, and there is no aggregate endpoint): pipeline
 * "average score" and LLM "recommendation distribution" — those live only on
 * per-candidate assessments. Admin session-ops analytics live in Mission
 * Control (linked from the header), not duplicated here.
 *
 * Surface language: the glass system (docs/design/hello-glass-design-system.md).
 * One `GlassPanel` per logical block, `glass-sunken` wells inside, a staggered
 * reveal for the KPI strip, bounded lists. No legacy `components/ui` imports.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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
  KpiCard,
  LoadingPanel,
  PageHeader,
  RevealGroup,
  RevealItem,
  ScrollArea,
  SectionHeader,
  StatusBadge,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  cx,
} from '../components/design';
import type { StatusTone } from '../components/design';
import { DonutChart, LineChart } from '../components/charts';
import {
  candidateStatusLabel,
  candidateStatusTone,
  candidateFunnel,
  candidatesHref,
  normalizeStatus,
  recommendationLabel,
  RECOMMENDATION_ORDER,
  sessionsPerDay,
} from '../components/talent';
import { formatDateTime } from '../lib/datetime';
import { addIstDays, istDayStartUtcIso, istToday } from '../lib/ist-datetime';
import type { PhoneCalendarResponse } from '../types';

const INTENT_KIND_META: Record<string, { title: string; tone: StatusTone }> = {
  assessment_ready: { title: 'Screening ready for review', tone: 'info' },
  appeal_resolved: { title: 'Appeal resolved — review outcome', tone: 'success' },
  quota_warning: { title: 'Session quota nearing its limit', tone: 'warning' },
};

/** Same clothes as the Mission Control header quick links. */
const quickLinkClass =
  'inline-flex h-9 items-center gap-2 rounded-control bg-white/70 pl-2 pr-3 text-[13px] font-medium text-ink shadow-[inset_0_0_0_1px_var(--glass-ring-strong)] transition-[background-color,box-shadow,transform] duration-200 ease-soft hover:-translate-y-px hover:bg-white hover:shadow-pill focus:outline-none focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-2 focus-visible:ring-offset-surface-secondary';

/** Inline link inside body copy and table cells — the accent, never a brand utility. */
const inlineLinkClass =
  'font-medium text-info hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-info';

export function DashboardPage() {
  const navigate = useNavigate();
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

  const funnel = useMemo(
    () =>
      candidates
        ? candidateFunnel(candidates).map((f) => ({
            label: f.label,
            value: f.value,
            href: candidatesHref({ statuses: [f.status] }),
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

  const intakeTrend = sessionsPerDay(candidates);

  return (
    <div>
      <PageHeader
        eyebrow="Talent workspace"
        title="Dashboard"
        description="Your pipeline at a glance — every figure comes from live data and drills into the matching candidates."
        actions={
          <>
            <Button size="sm" variant="secondary" onClick={load}>
              Refresh
            </Button>
            {me.role === 'admin' && (
              /*
                Session operations, recording integrity and quotas live in
                Mission Control. A real <Link> in the header (keyboard
                reachable, open-in-new-tab friendly) replaces the trailing
                paragraph that used to carry the same destination.
              */
              <Link to="/mission-control" className={quickLinkClass}>
                <span
                  aria-hidden="true"
                  className="flex h-5 w-5 items-center justify-center rounded-md bg-info-soft text-[10px] font-semibold text-info"
                >
                  MC
                </span>
                Mission Control
                <ArrowIcon />
              </Link>
            )}
          </>
        }
      />

      {/* KPI strip — every card is a drill-down link */}
      <RevealGroup className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <RevealItem className="h-full">
          <KpiLink
            href={candidatesHref()}
            label="Candidates"
            value={total}
            hint="in pipeline"
            ariaLabel={`${total} candidates in pipeline. View all candidates.`}
          />
        </RevealItem>
        <RevealItem className="h-full">
          <KpiLink
            href={candidatesHref({ statuses: ['new'] })}
            label="Awaiting screening"
            value={awaiting}
            tone={awaiting > 0 ? 'warning' : 'default'}
            hint="new · not yet screened"
            ariaLabel={`${awaiting} candidates awaiting screening. View them.`}
          />
        </RevealItem>
        <RevealItem className="h-full">
          <KpiLink
            href={candidatesHref({ statuses: ['queued', 'screening'] })}
            label="In screening"
            value={inScreening}
            tone={inScreening > 0 ? 'warning' : 'default'}
            hint="queued or active"
            ariaLabel={`${inScreening} candidates in screening. View them.`}
          />
        </RevealItem>
        <RevealItem className="h-full">
          <KpiLink
            href={candidatesHref({ statuses: ['screened'] })}
            label="Awaiting decision"
            value={awaitingDecision}
            tone={awaitingDecision > 0 ? 'info' : 'default'}
            hint="screened · ready to review"
            ariaLabel={`${awaitingDecision} candidates awaiting a decision. Review them.`}
          />
        </RevealItem>
      </RevealGroup>

      {/* Editorial row — the funnel reads wide, the summaries stack beside it */}
      <div className="mt-6 grid grid-cols-1 items-start gap-6 lg:grid-cols-12">
        <ChartCard
          title="Screening funnel"
          description="Candidates by pipeline stage. Select a stage to view those candidates."
          className="lg:col-span-7"
        >
          <DonutChart
            title="Screening funnel"
            data={funnel}
            isLoading={false}
            height={240}
            onSegmentSelect={(i) => {
              const target = funnel[i];
              if (target) navigate(target.href);
            }}
          />
        </ChartCard>

        <div className="flex flex-col gap-6 lg:col-span-5">
          <CompletionCard
            completionPct={completionPct}
            decided={decided}
            considered={considered}
          />
          <OutcomeLinks advanced={byStatus(['advanced'])} rejected={byStatus(['rejected'])} />
        </div>
      </div>

      {/* Assessment outcomes — average score + recommendation distribution */}
      <div className="mt-6 grid grid-cols-1 items-start gap-6 lg:grid-cols-12">
        <div className="lg:col-span-4">
          <AverageScoreCard summary={summary} error={summaryError} />
        </div>
        <div className="lg:col-span-8">
          <RecommendationDistribution
            summary={summary}
            error={summaryError}
            onRetry={load}
          />
        </div>
      </div>

      {/* Intake trend — all roles, from candidate.created_at */}
      <div className="mt-6">
        <ChartCard
          title="Candidates added"
          description="New candidates entering the pipeline per day over the last 14 days (real counts)."
        >
          <LineChart
            title="Candidates added per day"
            data={intakeTrend}
            unit="candidates"
            isLoading={false}
            height={220}
          />
        </ChartCard>
      </div>

      {/* Recent candidates + prioritized work */}
      <div className="mt-6 grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
        <RecentCandidates candidates={candidates} />
        <ActionQueue
          intents={intents}
          intentsError={intentsError}
          candidates={candidates}
          viewer={me.role === 'viewer'}
        />
      </div>

      {me.role !== 'viewer' && (
        <PhoneScheduleCard data={phoneSchedule} error={phoneScheduleError} />
      )}
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
    <GlassPanel as="section" aria-labelledby="phone-schedule-heading" className="mt-6">
      <SectionHeader
        id="phone-schedule-heading"
        title="Phone schedule"
        description="Upcoming callbacks and screening appointments in IST."
        actions={
          <Link to="/phone-calendar" className={buttonClass('secondary', 'sm')}>
            Open phone calendar
          </Link>
        }
        className="mb-4"
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
          <div className="grid grid-cols-3 gap-3">
            <ScheduleMetric label="Upcoming" value={upcoming.length} />
            <ScheduleMetric
              label="Overdue"
              value={overdue.length}
              tone={overdue.length > 0 ? 'warning' : undefined}
            />
            <ScheduleMetric label="Loaded" value={data.count} />
          </div>
          {data.truncated && (
            <InlineNotice tone="warning" className="mt-3">
              The schedule is larger than this summary window; open the calendar for the full
              bounded view.
            </InlineNotice>
          )}
          {next.length > 0 ? (
            <ul className="mt-4 divide-y divide-glass-ring" aria-label="Next phone appointments">
              {next.map((appointment) => (
                <li
                  key={appointment.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-ink">
                      {appointment.candidate?.name ?? 'Candidate'}
                    </p>
                    <p className="text-[13px] text-ink-tertiary">
                      {formatDateTime(appointment.starts_at)} ·{' '}
                      {appointment.ist_start ?? 'IST time unavailable'} IST
                    </p>
                  </div>
                  <StatusBadge tone="info" className="shrink-0">
                    <span title={appointment.status}>{humanise(appointment.status)}</span>
                  </StatusBadge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-sm text-ink-secondary">
              No upcoming appointments in the next seven days.
            </p>
          )}
        </>
      )}
    </GlassPanel>
  );
}

/** `snake_case` backend enum → sentence case; the raw value stays in `title`. */
function humanise(raw: string): string {
  const spaced = raw.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function ScheduleMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'warning';
}) {
  return (
    <div className="glass-sunken p-3">
      <p className="text-[13px] font-medium text-ink-tertiary">{label}</p>
      <p
        className={cx(
          'mt-1 text-2xl font-semibold tabular-nums tracking-[-0.02em]',
          tone === 'warning' ? 'text-warning-text' : 'text-ink',
        )}
      >
        {value}
      </p>
    </div>
  );
}

/* ── KPI drill-down link ────────────────────────────────────────────── */

function KpiLink({
  href,
  label,
  value,
  hint,
  tone,
  ariaLabel,
}: {
  href: string;
  label: string;
  value: number;
  hint?: string;
  tone?: 'default' | 'success' | 'warning' | 'danger' | 'info';
  ariaLabel: string;
}) {
  // KpiCard only knows default/success/warning/danger; map 'info' → default.
  const cardTone = tone === 'info' ? 'default' : tone;
  return (
    <Link
      to={href}
      aria-label={ariaLabel}
      // The hover lift belongs to the link, and its radius must match the card
      // it wraps — otherwise the lifted shadow squares off the glass corners.
      className="group block h-full rounded-card glass-interactive focus:outline-none focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-2"
    >
      <KpiCard label={label} value={value} hint={hint} tone={cardTone} />
    </Link>
  );
}

function CompletionCard({
  completionPct,
  decided,
  considered,
}: {
  completionPct: number;
  decided: number;
  considered: number;
}) {
  // The track grows from zero after mount: a width transition only reads as
  // motion if the first painted frame is empty. It collapses under
  // prefers-reduced-motion via the global transition-duration override.
  const [drawn, setDrawn] = useState(0);
  useEffect(() => {
    setDrawn(completionPct);
  }, [completionPct]);

  return (
    <GlassPanel>
      <p className="text-[13px] font-medium text-ink-secondary">Completion</p>
      <p className="mt-2 text-stat tabular-nums text-ink">
        {completionPct}
        <span className="ml-0.5 text-base font-normal tracking-normal text-ink-tertiary">%</span>
      </p>
      <p className="mt-1 text-[13px] text-ink-tertiary">
        {decided} of {considered} decided (advanced or rejected)
      </p>
      <div
        className="mt-4 h-2 w-full overflow-hidden rounded-full bg-ink/[0.06]"
        role="img"
        aria-label={`Completion ${completionPct} percent`}
      >
        <div
          className="h-full rounded-full bg-info transition-[width] duration-700 ease-soft"
          style={{ width: `${drawn}%` }}
        />
      </div>
    </GlassPanel>
  );
}

function OutcomeLinks({ advanced, rejected }: { advanced: number; rejected: number }) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <OutcomeLink
        href={candidatesHref({ statuses: ['advanced'] })}
        label="Advanced"
        value={advanced}
        valueClass="text-success-text"
        ariaLabel={`${advanced} advanced candidates. View them.`}
      />
      <OutcomeLink
        href={candidatesHref({ statuses: ['rejected'] })}
        label="Rejected"
        value={rejected}
        valueClass="text-error-text"
        ariaLabel={`${rejected} rejected candidates. View them.`}
      />
    </div>
  );
}

function OutcomeLink({
  href,
  label,
  value,
  valueClass,
  ariaLabel,
}: {
  href: string;
  label: string;
  value: number;
  valueClass: string;
  ariaLabel: string;
}) {
  return (
    <Link
      to={href}
      aria-label={ariaLabel}
      className="group block h-full rounded-card focus:outline-none focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-2"
    >
      <GlassPanel interactive padding="sm" className="h-full">
        <p className="text-[13px] font-medium text-ink-secondary">{label}</p>
        <p className={cx('mt-1 text-xl font-semibold tabular-nums', valueClass)}>{value}</p>
      </GlassPanel>
    </Link>
  );
}

/* ── Assessment outcomes (server-side aggregate; truthful) ──────────── */

function AverageScoreCard({
  summary,
  error,
}: {
  summary: CandidatesSummary | null;
  error: string | null;
}) {
  const hasAvg = summary != null && summary.average_score != null;
  return (
    <Link
      to={candidatesHref({ assessed: true })}
      aria-label={
        hasAvg
          ? `Average assessment score ${summary!.average_score} across ${summary!.assessed_count} assessed candidates. View them.`
          : 'View assessed candidates.'
      }
      className="group block h-full rounded-card focus:outline-none focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-2"
    >
      <GlassPanel interactive className="flex h-full flex-col">
        <p className="text-[13px] font-medium text-ink-secondary">Average score</p>
        {error ? (
          <ErrorPanel compact className="mt-3" message={error} />
        ) : summary == null ? (
          <LoadingPanel compact />
        ) : summary.average_score == null ? (
          <>
            <p className="mt-2 text-stat tabular-nums text-ink-tertiary">—</p>
            <p className="mt-1 text-[13px] text-ink-tertiary">No assessments yet</p>
          </>
        ) : (
          <>
            <p className="mt-2 text-stat tabular-nums text-ink">
              {summary.average_score}
              <span className="ml-1 text-base font-normal tracking-normal text-ink-tertiary">
                / 100
              </span>
            </p>
            <p className="mt-1 text-[13px] text-ink-tertiary">
              across {summary.assessed_count} assessed candidate
              {summary.assessed_count === 1 ? '' : 's'}
            </p>
          </>
        )}
      </GlassPanel>
    </Link>
  );
}

function RecommendationDistribution({
  summary,
  error,
  onRetry,
}: {
  summary: CandidatesSummary | null;
  error: string | null;
  onRetry: () => void;
}) {
  const navigate = useNavigate();
  const dist = summary?.recommendation_distribution;
  const data = dist
    ? RECOMMENDATION_ORDER.filter((r) => dist[r] > 0).map((r) => ({
        label: recommendationLabel(r),
        value: dist[r],
        href: candidatesHref({ recommendations: [r] }),
      }))
    : [];
  const total = data.reduce((s, d) => s + d.value, 0);

  return (
    <ChartCard
      title="Recommendation distribution"
      description="Latest assessment recommendation per candidate. Select a category to view those candidates."
    >
      {error ? (
        <ErrorPanel compact className="h-full min-h-40" message={error} onRetry={onRetry} />
      ) : summary == null ? (
        <DonutChart title="Recommendation distribution" data={[]} isLoading height={240} />
      ) : total === 0 ? (
        <EmptyPanel
          compact
          className="h-full min-h-40"
          title="No assessments yet"
          hint="Recommendation counts appear once candidates are assessed."
        />
      ) : (
        <DonutChart
          title="Recommendation distribution"
          data={data}
          isLoading={false}
          height={240}
          onSegmentSelect={(i) => {
            const target = data[i];
            if (target?.href) navigate(target.href);
          }}
        />
      )}
    </ChartCard>
  );
}

/* ── Recent candidates (API returns newest-first) ───────────────────── */

function RecentCandidates({ candidates }: { candidates: Candidate[] }) {
  const recent = candidates.slice(0, 6);

  if (candidates.length === 0) {
    return (
      <GlassPanel as="section" aria-label="Recent candidates">
        <SectionHeader title="Recent candidates" className="mb-4" />
        <EmptyPanel
          compact
          title="No candidates yet"
          hint="Upload a resume from the Candidates page to start your pipeline."
          action={
            <Link to="/candidates" className={buttonClass('secondary', 'sm')}>
              Go to Candidates
            </Link>
          }
        />
      </GlassPanel>
    );
  }

  return (
    <GlassPanel as="section" aria-label="Recent candidates">
      <SectionHeader
        title="Recent candidates"
        meta={
          <span className="text-[13px] tabular-nums text-ink-tertiary">
            {candidates.length} total
          </span>
        }
        actions={
          candidates.length > recent.length ? (
            <Link to="/candidates" className={buttonClass('ghost', 'sm')}>
              View all {candidates.length}
            </Link>
          ) : undefined
        }
        className="mb-4"
      />
      <Table bare caption="Recent candidates, newest first">
        <THead>
          <Tr>
            <Th>Name</Th>
            <Th>Status</Th>
            <Th>Exp.</Th>
            <Th>Added</Th>
          </Tr>
        </THead>
        <TBody>
          {recent.map((candidate) => (
            <Tr key={candidate.id}>
              <Td>
                <Link to={`/candidates/${candidate.id}`} className={inlineLinkClass}>
                  {candidate.name || 'Unnamed'}
                </Link>
                {candidate.email && (
                  <p className="text-[13px] text-ink-tertiary">{candidate.email}</p>
                )}
              </Td>
              <Td>
                <StatusBadge tone={candidateStatusTone(candidate.status)}>
                  {candidateStatusLabel(candidate.status)}
                </StatusBadge>
              </Td>
              <Td className="whitespace-nowrap tabular-nums">
                {candidate.experience_years != null
                  ? `${candidate.experience_years} yr`
                  : '—'}
              </Td>
              <Td className="whitespace-nowrap tabular-nums text-ink-secondary">
                {formatDateTime(candidate.created_at, {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })}
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
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
    <ul className="divide-y divide-glass-ring">
      {shown.map((intent) => {
        const meta = INTENT_KIND_META[intent.kind] ?? {
          title: humanise(intent.kind),
          tone: 'neutral' as StatusTone,
        };
        const candidate = intent.candidate_id
          ? candidateById.get(intent.candidate_id)
          : undefined;
        return (
          <li key={intent.id} className="flex items-start justify-between gap-3 py-3">
            <div className="min-w-0">
              <StatusBadge tone={meta.tone}>{meta.title}</StatusBadge>
              <p className="mt-1.5 truncate text-sm text-ink">
                {candidate ? (
                  <Link to={`/candidates/${candidate.id}`} className={inlineLinkClass}>
                    {candidate.name || 'Unnamed candidate'}
                  </Link>
                ) : (
                  <span className="text-ink-tertiary">
                    {intent.candidate_id
                      ? 'Candidate no longer available'
                      : 'Workspace-wide'}
                  </span>
                )}
              </p>
              <p className="mt-0.5 text-[13px] text-ink-tertiary">
                {formatDateTime(intent.created_at)}
                {intent.consent_verified && (
                  <span className="ml-2 rounded-full bg-success-soft px-1.5 py-0.5 text-[11px] font-medium text-success-text">
                    consent verified
                  </span>
                )}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );

  return (
    <GlassPanel as="section" aria-label="Action queue">
      <SectionHeader title="Prioritized work" className="mb-4" />
      {viewer ? (
        <p className="py-6 text-center text-sm text-ink-tertiary">
          Action items require interviewer or admin access.
        </p>
      ) : intents === null && !intentsError ? (
        <LoadingPanel compact label="Loading action items…" />
      ) : intentsError ? (
        <ErrorPanel compact message={intentsError} />
      ) : shown.length === 0 ? (
        <EmptyPanel compact title="You're all caught up — no pending items." />
      ) : shown.length > QUEUE_SCROLL_AFTER ? (
        <ScrollArea maxHeight="22rem" label="Prioritized work">
          {list}
        </ScrollArea>
      ) : (
        list
      )}
    </GlassPanel>
  );
}
