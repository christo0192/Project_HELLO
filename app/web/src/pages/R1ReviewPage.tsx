/**
 * R1 review: one round, in the stakeholder's format, in HELLO's own look.
 *
 *   /interviews/:roundId?tab=overview|briefing|resume|recording&attempt=n&t=sec
 *
 * The id is an opaque UUID, so the address carries no personal data. The whole page comes from one
 * read (`GET /api/interview-rounds/:id/review`); a recording's link is minted separately, by the first
 * play. All four panels stay mounted, so a place in the recording survives a look at the scorecard,
 * and a hidden panel pauses the media.
 *
 * Who may read what is the API's decision, and this page shows what it answers. A 403 and a 404 read
 * the same: one plain "not available", which says nothing about whether the round exists. Anything
 * else is an error with Retry. A re-read keeps the page on screen until its answer is in.
 *
 * Copy. The appeal banner and every recording sentence are the existing ones. Consent, recording,
 * opt-out, appeal and jurisdiction wording is not written here. The two wordings Legal approved on
 * 2026-11-05 ("Consent given at 00:20", the what-if line) are for the phone Review screen and are
 * not used on this page.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { EmptyPanel, ErrorPanel, InlineNotice, Skeleton, SkeletonText } from '../components/design';
import { BriefingPanel } from '../components/r1-review/BriefingPanel';
import { OverviewPanel } from '../components/r1-review/OverviewPanel';
import type { TurnTarget } from '../components/r1-review/OverviewPanel';
import { RecordingPanel } from '../components/r1-review/RecordingPanel';
import type { ReviewCue } from '../components/r1-review/RecordingPanel';
import { ResumePanel } from '../components/r1-review/ResumePanel';
import { ReviewHeader } from '../components/r1-review/ReviewHeader';
import { DecisionBlockedBanner } from '../components/talent/CandidateOverviewSections';
import { CandidateShell } from '../components/talent/CandidateShell';
import { candidateDisplayName } from '../components/talent/ResumeReviewBadge';
import { Tabs } from '../components/talent/Tabs';
import { canActOnRound } from '../lib/r1';
import { attemptLabels, r1RecordingStateCopy } from '../lib/r1-recording';
import { cueSecFrom, reviewAttemptFrom, reviewTabFrom } from '../lib/r1-review';
import type { R1ReviewResponse } from '../lib/r1-types';
import type { MeResponse } from '../types';

type Load =
  | { status: 'loading' }
  | { status: 'ready'; review: R1ReviewResponse }
  | { status: 'error'; message: string }
  | { status: 'unavailable' };

function statusOf(error: unknown): number {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : 0;
}

function messageOf(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : '';
}

/** Every block at its final size, so the page does not move when the answer lands. */
function ReviewSkeleton() {
  return (
    <div role="status" aria-label="Loading the R1 review">
      <div data-review-skeleton="header" className="space-y-3">
        <Skeleton width="12rem" height={16} radius={3} />
        <Skeleton width="28rem" height={32} radius={4} className="max-w-full" />
        <Skeleton width="24rem" height={22} radius={3} className="max-w-full" />
      </div>
      <div data-review-skeleton="tabs" className="mt-6 h-9 border-b border-line" />
      <div data-review-skeleton="body" className="mt-6 grid gap-6 min-[1180px]:grid-cols-[minmax(0,1fr)_26rem]">
        <Skeleton width="100%" height="26rem" radius={4} />
        <SkeletonText lines={8} gap={12} />
      </div>
    </div>
  );
}

export function R1ReviewPage() {
  const { roundId = '' } = useParams<{ roundId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [readKey, setReadKey] = useState(0);
  const [me, setMe] = useState<MeResponse | null>(null);

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => api.getR1Review(roundId))
      .then((review) => {
        if (live) setLoad({ status: 'ready', review });
      })
      .catch((error: unknown) => {
        if (!live) return;
        const status = statusOf(error);
        if (status === 403 || status === 404) setLoad({ status: 'unavailable' });
        // A re-read that fails leaves the page as it was.
        else setLoad((current) => (current.status === 'ready' ? current : { status: 'error', message: messageOf(error) }));
      });
    return () => {
      live = false;
    };
  }, [roundId, readKey]);

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => api.getMe())
      .then((answer) => {
        if (live) setMe(answer);
      })
      // Nobody is offered a write when who is asking cannot be read.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const reread = useCallback(() => setReadKey((key) => key + 1), []);

  const [tabPress, setTabPress] = useState(0);
  const onTabClick = useCallback((id: string) => {
    if (id === 'recording') setTabPress((press) => press + 1);
  }, []);

  const [cue, setCue] = useState<ReviewCue | null>(() => {
    const sec = cueSecFrom(searchParams.get('t'));
    return sec === null ? null : { sec, row: null, nonce: 0 };
  });
  const nonceRef = useRef(0);

  const review = load.status === 'ready' ? load.review : null;
  const attempts = review?.attempts;
  const assessment = review?.assessment ?? null;
  const attempt = useMemo(
    () => (attempts ? reviewAttemptFrom(searchParams.get('attempt'), attempts, assessment) : null),
    [attempts, assessment, searchParams],
  );

  const recordingDisabled = attempt?.consent_withdrawn === true;
  const requested = reviewTabFrom(searchParams.get('tab'));
  const tab = requested === 'recording' && recordingDisabled ? 'overview' : requested;

  const selectTab = useCallback(
    (next: string) => {
      setSearchParams(
        (previous) => {
          const params = new URLSearchParams(previous);
          params.set('tab', next);
          return params;
        },
        // Switching tabs is not a navigation: Back leaves the review.
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const selectAttempt = useCallback(
    (attemptNumber: number) => {
      setCue(null);
      setSearchParams(
        (previous) => {
          const params = new URLSearchParams(previous);
          params.set('attempt', String(attemptNumber));
          params.delete('t');
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const openTurn = useCallback(
    ({ attemptNumber, row, sec }: TurnTarget) => {
      nonceRef.current += 1;
      setCue({ sec, row, nonce: nonceRef.current });
      setSearchParams(
        (previous) => {
          const params = new URLSearchParams(previous);
          params.set('tab', 'recording');
          params.set('attempt', String(attemptNumber));
          if (sec === null) params.delete('t');
          else params.set('t', String(sec));
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  if (load.status === 'loading') {
    return (
      <CandidateShell variant="inset">
        <ReviewSkeleton />
      </CandidateShell>
    );
  }

  if (load.status === 'unavailable') {
    return (
      <CandidateShell variant="inset">
        <EmptyPanel
          title="This interview is not available."
          hint="It may have been removed, or your role may not include it."
          action={
            <Link to="/candidates" className="text-sm text-ink underline underline-offset-2">
              Back to candidates
            </Link>
          }
        />
      </CandidateShell>
    );
  }

  if (load.status === 'error') {
    return (
      <CandidateShell variant="inset">
        <ErrorPanel
          message={load.message}
          onRetry={() => {
            setLoad({ status: 'loading' });
            reread();
          }}
        />
      </CandidateShell>
    );
  }

  const { review: body } = load;
  const candidateName = candidateDisplayName(body.candidate.name);
  const labels = attemptLabels(body.attempts);
  const mayCancelRejection = me !== null && canActOnRound(body.round, me.role, me.userId);

  return (
    <CandidateShell variant="inset">
      <ReviewHeader
        review={body}
        candidateName={candidateName}
        attempt={attempt}
        mayCancelRejection={mayCancelRejection}
        onSelectAttempt={selectAttempt}
        onChanged={reread}
      />

      {body.round.is_staff_dry_run && (
        <p role="note" className="mt-3 rounded-control border border-dashed border-ink-secondary px-3 py-2 text-sm font-medium text-ink">
          Not used for any decision
        </p>
      )}
      {body.round.scores_withheld && <DecisionBlockedBanner />}
      {attempt && recordingDisabled && (
        <InlineNotice tone="neutral" role="none" className="mt-3">
          <span className="block">{r1RecordingStateCopy(attempt.recording).detail}</span>
          {/* With no recording there is no deletion sentence to carry the reason, so this one does, in its words. */}
          <span className="block">
            {attempt.recording.state === 'none' ? 'The transcript is hidden because consent was withdrawn.' : 'The transcript is hidden.'}
          </span>
        </InlineNotice>
      )}

      <Tabs
        className="mt-4"
        ariaLabel="R1 review sections"
        selectedId={tab}
        onSelect={selectTab}
        onTabClick={onTabClick}
        items={[
          {
            id: 'overview',
            label: 'Overview',
            panel: <OverviewPanel review={body} attempt={attempt} candidateName={candidateName} onOpenTurn={openTurn} onCheckAgain={reread} />,
          },
          { id: 'briefing', label: 'Briefing', panel: <BriefingPanel rubric={body.rubric} attempt={attempt} /> },
          { id: 'resume', label: 'Resume', panel: <ResumePanel candidate={body.candidate} /> },
          {
            id: 'recording',
            label: 'Recording',
            disabled: recordingDisabled,
            panel:
              attempt && !recordingDisabled ? (
                <RecordingPanel
                  key={attempt.session_id}
                  roundId={body.round.id}
                  attempt={attempt}
                  attemptLabel={labels[body.attempts.indexOf(attempt)]}
                  candidateName={candidateName}
                  assessment={assessment}
                  events={body.events}
                  active={tab === 'recording'}
                  cue={cue}
                  tabPress={tabPress}
                  onNeedRefresh={reread}
                />
              ) : (
                <EmptyPanel title="There is no recording yet." />
              ),
          },
        ]}
      />
    </CandidateShell>
  );
}
