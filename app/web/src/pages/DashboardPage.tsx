/**
 * HELLO Talent Workspace — recruiter dashboard (Lane 3).
 *
 * Every number, chart and queue item here is derived from existing,
 * real API responses — nothing is fabricated:
 *
 *   - KPIs + status donut  ← GET /api/candidates (viewer+)
 *   - Action queue         ← GET /api/notifications (interviewer+), joined
 *                            to candidate names from the same load (no N+1)
 *   - Session charts       ← GET /api/admin/sessions (admin only) — rendered
 *                            ONLY for admins; others see a truthful note
 *   - Recent candidates    ← GET /api/candidates (already newest-first)
 *
 * No trend/delta chips: prior-period deltas are NOT derivable from these
 * endpoints, so KpiCard deltas are never used. No direct Supabase access.
 *
 * Charts pair with sr-only data tables and require <ThemeProvider> (Lane 5
 * mounts it in main.tsx before pages render).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';
import type {
  AdminSessionRow,
  Candidate,
  MeResponse,
  NotificationIntent,
} from '../types';
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
  candidateStatusCounts,
  candidateStatusLabel,
  candidateStatusTone,
  sessionStatusCounts,
  sessionsPerDay,
} from '../components/talent';
import type { StatusTone } from '../components/design/StatusBadge';

const INTENT_KIND_META: Record<string, { title: string; tone: StatusTone }> = {
  assessment_ready: { title: 'Screening ready for review', tone: 'info' },
  appeal_resolved: { title: 'Appeal resolved — review outcome', tone: 'success' },
  quota_warning: { title: 'Session quota nearing its limit', tone: 'warning' },
};

export function DashboardPage() {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [intents, setIntents] = useState<NotificationIntent[] | null>(null);
  const [sessions, setSessions] = useState<AdminSessionRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [intentsError, setIntentsError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    setCandidates(null);
    setMe(null);
    setIntents(null);
    setSessions(null);
    setSessionError(null);
    setIntentsError(null);

    api
      .getMe()
      .then((nextMe) => {
        setMe(nextMe);
        // Session + intent data are role-gated; only fetch what the caller
        // can actually read so the page never makes a doomed 403 call.
        if (nextMe.role === 'admin') {
          api
            .listAdminSessions()
            .then((r) => setSessions(r.sessions))
            .catch((e: ApiError) => setSessionError(e.message));
        }
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

  if (loadError) {
    return <ErrorState message={loadError} onRetry={load} />;
  }
  if (!candidates || !me) {
    return <LoadingState label="Loading dashboard…" />;
  }

  const totalCandidates = candidates.length;
  const awaiting = candidates.filter((c) => (c.status ?? 'new') === 'new').length;
  const inScreening = candidates.filter(
    (c) => c.status === 'screening' || c.status === 'queued',
  ).length;
  const reviewsPending =
    intents?.filter((i) => i.kind === 'assessment_ready').length ?? 0;
  const statusCounts = candidateStatusCounts(candidates);

  return (
    <div>
      <PageHeader
        eyebrow="Talent workspace"
        title="Dashboard"
        description="Today's screening activity across your pipeline — every number is derived from live API data."
        actions={
          <button
            type="button"
            onClick={load}
            className="inline-flex items-center rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink-secondary transition-colors hover:bg-surface-tertiary hover:text-ink"
          >
            Refresh
          </button>
        }
      />

      {/* KPI row — no fabricated deltas */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Candidates"
          value={totalCandidates}
          hint="in pipeline"
        />
        <KpiCard
          label="Awaiting screening"
          value={awaiting}
          tone={awaiting > 0 ? 'warning' : 'default'}
          hint="new, not yet screened"
        />
        <KpiCard
          label="In screening"
          value={inScreening}
          tone={inScreening > 0 ? 'warning' : 'default'}
          hint="active or queued"
        />
        {intents !== null ? (
          <KpiCard
            label="Ready for review"
            value={reviewsPending}
            hint="assessments awaiting review"
          />
        ) : (
          <div className="rounded-xl border border-line bg-surface p-5 shadow-card">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-secondary">
              Ready for review
            </p>
            <p className="mt-2 text-sm text-ink-tertiary">
              Requires interviewer or admin access.
            </p>
          </div>
        )}
      </div>

      {/* Charts — only what the source data supports */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartCard
          title="Candidate status"
          description="Distribution of candidates across the pipeline."
        >
          <DonutChart
            title="Candidate status"
            data={statusCounts}
            isLoading={false}
            height={240}
          />
        </ChartCard>

        {me.role === 'admin' && sessions !== null ? (
          <>
            <ChartCard
              title="Sessions by status"
              description={`${sessions.length} sessions total across the workspace.`}
            >
              <DonutChart
                title="Sessions by status"
                data={sessionStatusCounts(sessions)}
                isLoading={false}
                height={240}
              />
            </ChartCard>
            <ChartCard
              title="Sessions started"
              description="Sessions created per day over the last 14 days (real counts)."
              className="lg:col-span-2"
            >
              <LineChart
                title="Sessions started per day"
                data={sessionsPerDay(sessions)}
                unit="sessions"
                isLoading={false}
                height={220}
              />
            </ChartCard>
          </>
        ) : me.role === 'admin' && sessionError ? (
          <ChartCard
            title="Session metrics"
            description="Session charts are unavailable right now."
          >
            <div role="alert" className="flex h-full min-h-40 flex-col items-center justify-center gap-3 rounded-xl border border-error/30 bg-error-soft px-4 text-center">
              <p className="max-w-md text-sm text-error">{sessionError}</p>
              <button
                type="button"
                onClick={load}
                className="inline-flex items-center rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-surface-tertiary"
              >
                Try again
              </button>
            </div>
          </ChartCard>
        ) : (
          <ChartCard
            title="Session metrics"
            description="Session volume and status trends."
          >
            <div className="flex h-full min-h-40 flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-line-strong bg-surface-secondary px-4 text-center">
              <p className="text-sm font-medium text-ink-secondary">
                Session metrics require admin access
              </p>
              <p className="max-w-sm text-xs text-ink-tertiary">
                Ask an admin to review session volume, or view sessions from a
                candidate's profile.
              </p>
            </div>
          </ChartCard>
        )}
      </div>

      {/* Recent candidates + action queue */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <RecentCandidates candidates={candidates} />
        <ActionQueue
          intents={intents}
          intentsError={intentsError}
          candidates={candidates}
          viewer={me.role === 'viewer'}
        />
      </div>
    </div>
  );
}

/* ── Recent candidates (API returns newest-first) ───────────────────── */

function RecentCandidates({ candidates }: { candidates: Candidate[] }) {
  const recent = candidates.slice(0, 6);

  if (candidates.length === 0) {
    return (
      <section aria-label="Recent candidates" className="rounded-xl border border-dashed border-line-strong bg-surface-secondary p-8 text-center">
        <p className="text-sm font-medium text-ink-secondary">No candidates yet</p>
        <p className="mx-auto mt-1 max-w-sm text-xs text-ink-tertiary">
          Upload a resume from the Candidates page to start your pipeline.
        </p>
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
                  className="font-medium text-brand-700 hover:text-brand-800 dark:text-brand-300"
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
                {new Date(candidate.created_at).toLocaleDateString()}
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
      {candidates.length > recent.length && (
        <Link
          to="/candidates"
          className="mt-3 inline-block text-xs font-medium text-brand-700 hover:text-brand-800 dark:text-brand-300"
        >
          View all {candidates.length} candidates →
        </Link>
      )}
    </section>
  );
}

/* ── Action queue (real notification intents, no fabrication) ───────── */

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
      <h2 className="mb-3 text-sm font-semibold text-ink">Action queue</h2>
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
                          className="font-medium text-brand-700 hover:text-brand-800 dark:text-brand-300"
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
                      {new Date(intent.created_at).toLocaleString()}
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
