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
 * Control (linked), not duplicated here.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import type { Candidate, CandidatesSummary, MeResponse, NotificationIntent } from '../types';
import { ErrorState, LoadingState } from '../components/ui';
import { PageHeader } from '../components/design';
import { KpiCard } from '../components/design';
import { ChartCard } from '../components/design';
import {
  Table,
  THead,
  TBody,
  Tr,
  Th,
  Td,
  StatusBadge,
} from '../components/design';
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
import type { StatusTone } from '../components/design/StatusBadge';

const INTENT_KIND_META: Record<string, { title: string; tone: StatusTone }> = {
  assessment_ready: { title: 'Screening ready for review', tone: 'info' },
  appeal_resolved: { title: 'Appeal resolved — review outcome', tone: 'success' },
  quota_warning: { title: 'Session quota nearing its limit', tone: 'warning' },
};

export function DashboardPage() {
  const navigate = useNavigate();
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [intents, setIntents] = useState<NotificationIntent[] | null>(null);
  const [summary, setSummary] = useState<CandidatesSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [intentsError, setIntentsError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    setCandidates(null);
    setMe(null);
    setIntents(null);
    setSummary(null);
    setSummaryError(null);
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
    return <ErrorState message={loadError} onRetry={load} />;
  }
  if (!candidates || !me) {
    return <LoadingState label="Loading dashboard…" />;
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
        description="Your screening pipeline at a glance — every figure is derived from live API data, and every card drills into the matching candidates."
        actions={
          <button
            type="button"
            onClick={load}
            className="inline-flex items-center rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink-secondary transition-colors hover:bg-surface-tertiary hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            Refresh
          </button>
        }
      />

      {/* KPI row — every card is a drill-down link */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiLink
          href={candidatesHref()}
          label="Candidates"
          value={total}
          hint="in pipeline"
          ariaLabel={`${total} candidates in pipeline. View all candidates.`}
        />
        <KpiLink
          href={candidatesHref({ statuses: ['new'] })}
          label="Awaiting screening"
          value={awaiting}
          tone={awaiting > 0 ? 'warning' : 'default'}
          hint="new · not yet screened"
          ariaLabel={`${awaiting} candidates awaiting screening. View them.`}
        />
        <KpiLink
          href={candidatesHref({ statuses: ['queued', 'screening'] })}
          label="In screening"
          value={inScreening}
          tone={inScreening > 0 ? 'warning' : 'default'}
          hint="queued or active"
          ariaLabel={`${inScreening} candidates in screening. View them.`}
        />
        <KpiLink
          href={candidatesHref({ statuses: ['screened'] })}
          label="Awaiting decision"
          value={awaitingDecision}
          tone={awaitingDecision > 0 ? 'info' : 'default'}
          hint="screened · ready to review"
          ariaLabel={`${awaitingDecision} candidates awaiting a decision. Review them.`}
        />
      </div>

      {/* Funnel + completion + trend */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <ChartCard
          title="Screening funnel"
          description="Candidates by pipeline stage. Select a stage to view those candidates."
          className="lg:col-span-2"
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

        <div className="flex flex-col gap-6">
          <CompletionCard
            completionPct={completionPct}
            decided={decided}
            considered={considered}
          />
          <OutcomeLinks advanced={byStatus(['advanced'])} rejected={byStatus(['rejected'])} />
        </div>
      </div>

      {/* Assessment outcomes — average score + recommendation distribution */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <AverageScoreCard summary={summary} error={summaryError} />
        <div className="lg:col-span-2">
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
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <RecentCandidates candidates={candidates} />
        <ActionQueue
          intents={intents}
          intentsError={intentsError}
          candidates={candidates}
          viewer={me.role === 'viewer'}
        />
      </div>

      {me.role === 'admin' && (
        <p className="mt-6 text-sm text-ink-secondary">
          Looking for session operations, recordings integrity and quotas?{' '}
          <Link
            to="/mission-control"
            className="font-medium text-brand-700 hover:text-brand-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-brand-300"
          >
            Open Mission Control →
          </Link>
        </p>
      )}
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
      className="group block rounded-xl transition-shadow hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
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
  return (
    <div className="rounded-xl border border-line bg-surface p-5 shadow-card">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-secondary">
        Completion
      </p>
      <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight text-ink">
        {completionPct}
        <span className="ml-0.5 text-base font-normal text-ink-tertiary">%</span>
      </p>
      <p className="mt-1 text-xs text-ink-tertiary">
        {decided} of {considered} decided (advanced or rejected)
      </p>
      <div
        className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-tertiary"
        role="img"
        aria-label={`Completion ${completionPct} percent`}
      >
        <div
          className="h-full rounded-full bg-brand-500"
          style={{ width: `${completionPct}%` }}
        />
      </div>
    </div>
  );
}

function OutcomeLinks({ advanced, rejected }: { advanced: number; rejected: number }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Link
        to={candidatesHref({ statuses: ['advanced'] })}
        className="rounded-xl border border-line bg-surface p-4 shadow-card transition-shadow hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        aria-label={`${advanced} advanced candidates. View them.`}
      >
        <p className="text-xs font-medium uppercase tracking-wide text-ink-secondary">
          Advanced
        </p>
        <p className="mt-1 text-xl font-semibold tabular-nums text-success">{advanced}</p>
      </Link>
      <Link
        to={candidatesHref({ statuses: ['rejected'] })}
        className="rounded-xl border border-line bg-surface p-4 shadow-card transition-shadow hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        aria-label={`${rejected} rejected candidates. View them.`}
      >
        <p className="text-xs font-medium uppercase tracking-wide text-ink-secondary">
          Rejected
        </p>
        <p className="mt-1 text-xl font-semibold tabular-nums text-error">{rejected}</p>
      </Link>
    </div>
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
      className="group block rounded-xl border border-line bg-surface p-5 shadow-card transition-shadow hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      <p className="text-xs font-medium uppercase tracking-wide text-ink-secondary">
        Average score
      </p>
      {error ? (
        <p className="mt-2 text-sm text-error">{error}</p>
      ) : summary == null ? (
        <p className="mt-2 text-sm text-ink-tertiary">Loading…</p>
      ) : summary.average_score == null ? (
        <>
          <p className="mt-2 text-2xl font-semibold text-ink-tertiary">—</p>
          <p className="mt-1 text-xs text-ink-tertiary">No assessments yet</p>
        </>
      ) : (
        <>
          <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight text-ink">
            {summary.average_score}
            <span className="ml-0.5 text-base font-normal text-ink-tertiary">/ 100</span>
          </p>
          <p className="mt-1 text-xs text-ink-tertiary">
            across {summary.assessed_count} assessed candidate
            {summary.assessed_count === 1 ? '' : 's'}
          </p>
        </>
      )}
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
        <div role="alert" className="flex h-full min-h-40 flex-col items-center justify-center gap-3 rounded-xl border border-error/30 bg-error-soft px-4 text-center">
          <p className="max-w-md text-sm text-error">{error}</p>
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-surface-tertiary"
          >
            Try again
          </button>
        </div>
      ) : summary == null ? (
        <DonutChart title="Recommendation distribution" data={[]} isLoading height={240} />
      ) : total === 0 ? (
        <div className="flex h-full min-h-40 flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-line-strong bg-surface-secondary px-4 text-center">
          <p className="text-sm font-medium text-ink-secondary">No assessments yet</p>
          <p className="max-w-sm text-xs text-ink-tertiary">
            Recommendation counts appear once candidates are assessed.
          </p>
        </div>
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
      <section
        aria-label="Recent candidates"
        className="rounded-xl border border-dashed border-line-strong bg-surface-secondary p-8 text-center"
      >
        <p className="text-sm font-medium text-ink-secondary">No candidates yet</p>
        <p className="mx-auto mt-1 max-w-sm text-xs text-ink-tertiary">
          Upload a resume from the Candidates page to start your pipeline.
        </p>
        <Link
          to="/candidates"
          className="mt-3 inline-block text-xs font-medium text-brand-700 hover:text-brand-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-brand-300"
        >
          Go to Candidates →
        </Link>
      </section>
    );
  }

  return (
    <section aria-label="Recent candidates">
      <h2 className="mb-3 text-sm font-semibold text-ink">Recent candidates</h2>
      <Table caption="Recent candidates, newest first">
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
                <Link
                  to={`/candidates/${candidate.id}`}
                  className="font-medium text-brand-700 hover:text-brand-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-brand-300"
                >
                  {candidate.name || 'Unnamed'}
                </Link>
                {candidate.email && (
                  <p className="text-xs text-ink-tertiary">{candidate.email}</p>
                )}
              </Td>
              <Td>
                <StatusBadge tone={candidateStatusTone(candidate.status)}>
                  {candidateStatusLabel(candidate.status)}
                </StatusBadge>
              </Td>
              <Td className="tabular-nums">
                {candidate.experience_years != null
                  ? `${candidate.experience_years} yr`
                  : '—'}
              </Td>
              <Td className="tabular-nums text-ink-secondary">
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
      {candidates.length > recent.length && (
        <Link
          to="/candidates"
          className="mt-3 inline-block text-xs font-medium text-brand-700 hover:text-brand-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-brand-300"
        >
          View all {candidates.length} candidates →
        </Link>
      )}
    </section>
  );
}

/* ── Prioritized work queue (real notification intents, no fabrication) ─ */

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

  return (
    <section aria-label="Action queue">
      <h2 className="mb-3 text-sm font-semibold text-ink">Prioritized work</h2>
      <div className="rounded-xl border border-line bg-surface shadow-card">
        {viewer ? (
          <p className="px-4 py-6 text-center text-sm text-ink-tertiary">
            Action items require interviewer or admin access.
          </p>
        ) : intents === null && !intentsError ? (
          <p className="px-4 py-6 text-center text-sm text-ink-tertiary">
            Loading action items…
          </p>
        ) : intentsError ? (
          <div role="alert" className="m-3 rounded-lg border border-error/30 bg-error-soft p-3">
            <p className="text-sm text-error">{intentsError}</p>
          </div>
        ) : intents === null || intents.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-ink-secondary">
            You're all caught up — no pending items.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {intents.slice(0, 8).map((intent) => {
              const meta = INTENT_KIND_META[intent.kind] ?? {
                title: intent.kind,
                tone: 'neutral' as StatusTone,
              };
              const candidate = intent.candidate_id
                ? candidateById.get(intent.candidate_id)
                : undefined;
              return (
                <li key={intent.id} className="flex items-start justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <StatusBadge tone={meta.tone}>{meta.title}</StatusBadge>
                    <p className="mt-1.5 truncate text-sm text-ink">
                      {candidate ? (
                        <Link
                          to={`/candidates/${candidate.id}`}
                          className="font-medium text-brand-700 hover:text-brand-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-brand-300"
                        >
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
                    <p className="mt-0.5 text-xs text-ink-tertiary">
                      {formatDateTime(intent.created_at)}
                      {intent.consent_verified && (
                        <span className="ml-2 rounded bg-success-soft px-1.5 py-0.5 text-[11px] font-medium text-success">
                          consent verified
                        </span>
                      )}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
