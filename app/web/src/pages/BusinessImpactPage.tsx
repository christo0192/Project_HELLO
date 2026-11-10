/**
 * Business impact (M031 S6): what happened to the Ashby applications Christy
 * screened, from coming in to Hired. A person decides in Ashby; the page shows
 * what happened after Christy, not what Christy caused.
 *
 * Reads `GET /api/impact/summary` and, behind any count, `GET
 * /api/impact/candidates`, exactly as `.gsd/milestones/M031/API-CONTRACT.md`
 * fixes them.
 *
 * ROLE. Interviewers and admins see it (owner decision D-M031-3, with the
 * candidate list). `ProtectedRoute` matches one exact role, so the route is
 * authenticated only and the page tells the roles apart itself, as the phone
 * calendar does: a viewer gets a truthful panel and no impact read is made at
 * all. The API checks the role on every call regardless.
 *
 * FILTERS live in the address (`?job=`, `?weeks=`), so a trip to a candidate
 * and back keeps them. Weeks are IST weeks starting Monday, the current week
 * included, and the summary is always sent an explicit window.
 *
 * STATES. Loading, failed and empty are three different things: a failed read
 * says what to do and offers a Retry; empty is said only after a read
 * succeeded; a figure Ashby has not given yet is a dash, never a 0, with a
 * notice saying why.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import {
  Combobox,
  EmptyPanel,
  ErrorPanel,
  GlassPanel,
  InlineNotice,
  LoadingPanel,
  PageHeader,
  SegmentedControl,
} from '../components/design';
import {
  ImpactCandidateList,
  ImpactCohorts,
  ImpactDefinitions,
  ImpactLeaves,
  ImpactPipeline,
  ImpactTimings,
  ImpactVerdictOutcomes,
  type OpenImpactList,
  type OpenImpactListRequest,
} from '../components/impact';
import { apiErrorCopy, plainErrorText } from '../lib/api-error-copy';
import { fetchImpactSummary, type ImpactJobOption, type ImpactSummary } from '../lib/impact';
import {
  DEFAULT_IMPACT_WEEKS,
  IMPACT_WEEK_OPTIONS,
  ashbyStagesRead,
  cohortWeekLabel,
  freshnessLine,
  staleLine,
  unlabelledNotice,
  weeksFrom,
  weeksPhrase,
  weeksWindow,
  type ImpactWeeks,
} from '../lib/impact-format';
import type { MeResponse } from '../types';

const TITLE = 'Business impact';
const DESCRIPTION = 'Ashby applications Christy screened. A person decides in Ashby.';

type SummaryState =
  | { status: 'loading' }
  | { status: 'ready'; data: ImpactSummary }
  | { status: 'failed'; error: unknown };

/**
 * Words for the window and job a list is read for: "last 12 weeks, all jobs". A
 * window other than the page's is a cohort week. Both ends are compared: the
 * oldest week starts on the page's own first Monday and differs only in its end.
 */
function scopeText(
  params: { from?: string; to?: string; job?: string | null },
  page: { from: string; to: string },
  weeks: ImpactWeeks,
  jobs: ReadonlyArray<ImpactJobOption>,
): string {
  const narrowed = Boolean(params.from && params.to) && (params.from !== page.from || params.to !== page.to);
  const when = narrowed && params.from ? `week of ${cohortWeekLabel(params.from)}` : weeksPhrase(weeks).toLowerCase();
  const job = params.job ? (jobs.find((option) => option.id === params.job)?.label ?? 'one job') : 'all jobs';
  return `${when}, ${job}`;
}

export function BusinessImpactPage() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [meError, setMeError] = useState<string | null>(null);

  const loadMe = useCallback(() => {
    setMeError(null);
    setMe(null);
    api
      .getMe()
      .then(setMe)
      .catch((error: ApiError) => setMeError(`We couldn't check your access. ${plainErrorText(error.message)}`));
  }, []);
  useEffect(loadMe, [loadMe]);

  const role = me?.role ?? null;
  const canRead = role === 'admin' || role === 'interviewer';

  const [searchParams, setSearchParams] = useSearchParams();
  const weeks = weeksFrom(searchParams.get('weeks'));
  const job = searchParams.get('job') || null;
  const range = useMemo(() => weeksWindow(weeks), [weeks]);

  const [summary, setSummary] = useState<SummaryState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  /** The job picker's options, kept from the last answer so a failed reload keeps the picker. */
  const [jobs, setJobs] = useState<ImpactJobOption[] | null>(null);

  useEffect(() => {
    // A viewer never asks the impact API anything.
    if (!canRead) return undefined;
    let live = true;
    const controller = new AbortController();
    setSummary({ status: 'loading' });
    fetchImpactSummary({ from: range.from, to: range.to, job }, controller.signal)
      .then((data) => {
        if (!live) return;
        setSummary({ status: 'ready', data });
        setJobs(data.filters.jobs);
      })
      .catch((error: unknown) => {
        if (live) setSummary({ status: 'failed', error });
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [canRead, range.from, range.to, job, attempt]);

  const changeAddress = useCallback(
    (edit: (params: URLSearchParams) => void) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          edit(next);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const selectWeeks = useCallback(
    (next: ImpactWeeks) =>
      changeAddress((params) => {
        if (next === DEFAULT_IMPACT_WEEKS) params.delete('weeks');
        else params.set('weeks', next);
      }),
    [changeAddress],
  );

  const selectJob = useCallback(
    (next: string) =>
      changeAddress((params) => {
        if (next) params.set('job', next);
        else params.delete('job');
      }),
    [changeAddress],
  );

  /** The address names a filter, so a refused read has something to reset. */
  const filtered = searchParams.has('job') || searchParams.has('weeks');
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const resetFilters = useCallback(() => {
    changeAddress((params) => {
      params.delete('job');
      params.delete('weeks');
    });
    // A reset that changes the window or the job reads again by itself. One that does not (`?weeks=`
    // naming no option, an empty `?job=`) changes nothing the read depends on, so ask again outright,
    // or the panel would stay standing. Not both: the router applies the address in a transition, so
    // an outright retry beside it would read once more with the refused filter.
    if (job === null && weeks === DEFAULT_IMPACT_WEEKS) retry();
  }, [changeAddress, retry, job, weeks]);

  // A job that is not (or no longer) offered falls back to all jobs, rather than
  // filtering on one the picker cannot show.
  const unknownJob = job !== null && jobs !== null && !jobs.some((option) => option.id === job);
  useEffect(() => {
    if (unknownJob) selectJob('');
  }, [unknownJob, selectJob]);

  const openerRef = useRef<HTMLElement | null>(null);
  const [list, setList] = useState<OpenImpactListRequest | null>(null);
  const openList = useCallback<OpenImpactList>(
    (request, opener) => {
      openerRef.current = opener;
      const params = { from: range.from, to: range.to, job, ...request.scope };
      // A cohort week ends on its Sunday, but the newest one is still running: the list never asks
      // past the page's own last day (today, IST), as the summary never does.
      if (params.to && params.to > range.to) params.to = range.to;
      setList({ ...request, params, scopeText: scopeText(params, range, weeks, jobs ?? []) });
    },
    [range, job, weeks, jobs],
  );

  if (meError) return <ErrorPanel message={meError} onRetry={loadMe} />;
  if (!me) return <LoadingPanel label="Checking access…" />;

  if (!canRead) {
    return (
      <div>
        <PageHeader title={TITLE} description={DESCRIPTION} />
        <GlassPanel level="ruled" padding="sm" className="mt-6">
          <EmptyPanel
            title="Not available to your role"
            hint="Business impact is available to interviewers and admins. Nothing about it has been loaded for this account."
          />
        </GlassPanel>
      </div>
    );
  }

  const data = summary.status === 'ready' ? summary.data : null;
  const meta = data?.meta ?? null;
  const ashbyRead = meta ? ashbyStagesRead(meta) : true;
  const cameIn = data?.pipeline[0]?.reached;
  const empty = data !== null && !(typeof cameIn === 'number' && cameIn > 0);
  const stale = meta ? staleLine(meta) : null;
  const unlabelled = meta ? unlabelledNotice(meta) : null;
  const failure = summary.status === 'failed' ? summary.error : null;
  const failureCode = failure instanceof ApiError ? failure.code : null;
  const failureStatus = failure instanceof ApiError ? failure.status : null;

  const jobOptions = [{ value: '', label: 'All jobs' }, ...(jobs ?? []).map((option) => ({ value: option.id, label: option.label }))];

  return (
    <div>
      <PageHeader
        title={TITLE}
        description={DESCRIPTION}
        actions={
          <div className="flex w-full flex-wrap items-end gap-3 sm:w-auto">
            <div className="flex w-full flex-col gap-1 sm:w-64">
              <span id="impact-job-label" className="form-label">
                Job
              </span>
              <Combobox
                id="impact-job"
                labelId="impact-job-label"
                size="md"
                floating
                value={job ?? ''}
                onChange={selectJob}
                options={jobOptions}
                placeholder="All jobs"
                searchLabel="Search jobs"
                listLabel="Mapped Ashby jobs"
                noun={['job', 'jobs']}
                loading={jobs === null && summary.status === 'loading'}
                className="w-full"
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="form-label" aria-hidden="true">
                Weeks
              </span>
              <SegmentedControl ariaLabel="Weeks" value={weeks} onChange={selectWeeks} options={IMPACT_WEEK_OPTIONS} />
            </div>
          </div>
        }
      />

      {meta && (
        <p data-testid="impact-freshness" className="mt-3 text-meta text-ink-secondary">
          {freshnessLine(meta)}.{stale ? ` ${stale}` : ''}
        </p>
      )}
      {meta && !ashbyRead && (
        <InlineNotice tone="warning" className="mt-3">
          Ashby stages are not being read yet. Every step from “A person decided in Ashby” onward shows a dash until
          they are, and Christy’s own steps are counted as usual.
        </InlineNotice>
      )}
      {unlabelled && (
        <InlineNotice tone="warning" className="mt-3">
          {unlabelled}
        </InlineNotice>
      )}

      {summary.status === 'loading' && (
        <GlassPanel level="ruled" padding="md" className="mt-6">
          <LoadingPanel label="Loading business impact…" />
        </GlassPanel>
      )}

      {failure !== null && (
        <GlassPanel level="ruled" padding="md" className="mt-6" tabIndex={-1}>
          {failureCode === 'invalid_filter' && filtered ? (
            <ErrorPanel message={`Business impact couldn’t load. ${apiErrorCopy(failure)}`} onRetry={resetFilters} retryLabel="Reset filters" />
          ) : failureCode === 'invalid_filter' ? (
            // Nothing in the address to reset: the refused window is the page's own default.
            <ErrorPanel
              message="Business impact couldn’t load. The weeks this page asked for were not accepted. Try again in a moment."
              onRetry={retry}
            />
          ) : (
            <ErrorPanel
              message={`Business impact couldn’t load. ${apiErrorCopy(failure)}`}
              onRetry={failureStatus === 403 ? undefined : retry}
            />
          )}
        </GlassPanel>
      )}

      {data && empty && (
        <GlassPanel level="ruled" padding="md" className="mt-6">
          <EmptyPanel
            title="No Ashby application came in during these weeks"
            hint="An application counts in the IST week it entered the Christy stage. Choose more weeks, or all jobs."
          />
        </GlassPanel>
      )}

      {data && meta && !empty && (
        <>
          <ImpactPipeline pipeline={data.pipeline} onOpen={openList} />
          <ImpactVerdictOutcomes outcomes={data.verdictOutcomes} onOpen={openList} />
          <ImpactLeaves leaves={data.leaves} ashbyRead={ashbyRead} onOpen={openList} />
          <ImpactTimings timings={data.timings} minTimingN={meta.minTimingN} ashbyRead={ashbyRead} />
          <ImpactCohorts cohorts={data.cohorts} byJob={data.byJob} job={job} onOpen={openList} />
        </>
      )}

      <ImpactDefinitions minTimingN={meta?.minTimingN ?? 5} />

      <ImpactCandidateList request={list} onClose={() => setList(null)} returnFocusRef={openerRef} />
    </div>
  );
}
