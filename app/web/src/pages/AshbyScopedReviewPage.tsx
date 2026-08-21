/**
 * AshbyScopedReviewPage — the candidate-scoped review experience opened from an
 * Ashby scorecard deep link (`/ashby/review/:applicationLinkId`).
 *
 * Shell rules (deliberate, and asserted by tests):
 *   - Authenticated: the route sits behind the normal `ProtectedRoute`, so an
 *     IK/Supabase session plus a resolved role is required. The link itself is
 *     NOT a capability — it carries no bearer token, and the API re-applies the
 *     same interviewer ownership/RBAC rules as the normal candidate page.
 *   - Dedicated shell: rendered OUTSIDE `<Layout>`, so there is no global nav,
 *     no sidebar, no "back to candidates" link and no cross-candidate
 *     navigation. Nothing here leaves the linked candidate.
 *   - Read-only: exactly the existing Overview and Review content, minus the
 *     actions (start a call, add a note, issue an appeal grant, export CSV).
 *     Those stay on the unchanged full workspace page.
 *   - No PII in the URL: the address is the opaque application link id only.
 *   - Terminal for the SSO deep link: reaching this page means the parked
 *     return-to has served its purpose, so it is cleared on mount. On the
 *     provider-honoured redirect path the browser lands here directly and
 *     `PostAuthLanding` never runs, so this is the only consumer — without it
 *     the parked entry lived out its TTL and re-routed a later visit to `/`.
 *
 * Unknown, malformed, unauthorized and unowned links are indistinguishable —
 * the API answers all four with the same 404 and this page shows one generic
 * "not available" state.
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import type { CandidateDetail, Note } from '../types';
import { Card, ErrorState, LoadingState } from '../components/ui';
import { clearReturnTo } from '../lib/return-to';
import { StatusBadge } from '../components/design';
import {
  AshbyWorkflowCard,
  CandidateProfileCard,
  DecisionBlockedBanner,
  NotesList,
  SessionsSummary,
  Tabs,
  TranscriptionSyncWorkspace,
  candidateStatusLabel,
  candidateStatusTone,
} from '../components/talent';

/** Shown for every unresolvable link — never distinguishes why. */
const UNAVAILABLE =
  'This review link is not available. It may have been removed, or your account may not have access to it.';

export function AshbyScopedReviewPage() {
  const { applicationLinkId } = useParams<{ applicationLinkId: string }>();
  const [detail, setDetail] = useState<CandidateDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!applicationLinkId) {
      setError(UNAVAILABLE);
      return;
    }
    setError(null);
    setDetail(null);
    api
      .getAshbyScopedReview(applicationLinkId)
      .then((d) => setDetail(d))
      // 404 (unknown/malformed/unowned) and 403 collapse into one generic
      // state; only genuine transport/server failures surface a retry.
      .catch((e: ApiError) =>
        setError(e.status === 404 || e.status === 403 ? UNAVAILABLE : e.message),
      );
  }, [applicationLinkId]);

  // Arrival is the consume point for the parked SSO return-to, whichever
  // landing path got us here and regardless of what the API then answers.
  useEffect(clearReturnTo, []);

  useEffect(load, [load]);

  if (error) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <ErrorState
          message={error}
          onRetry={error === UNAVAILABLE ? undefined : load}
        />
      </main>
    );
  }
  if (!detail) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <LoadingState label="Loading review…" />
      </main>
    );
  }

  const { candidate, sessions, assessments } = detail;
  const decisionBlocked = candidate.decision_use_blocked_at != null;

  return (
    // No <Layout>: this shell intentionally has no global navigation.
    <main className="mx-auto max-w-6xl px-4 py-8">
      <header className="border-b border-line pb-5">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
          Candidate review
        </p>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold text-ink">
              {candidate.name || 'Unnamed candidate'}
            </h1>
            {candidate.email && (
              <p className="truncate text-sm text-ink-secondary">{candidate.email}</p>
            )}
          </div>
          <StatusBadge tone={candidateStatusTone(candidate.status)}>
            {candidateStatusLabel(candidate.status)}
          </StatusBadge>
        </div>
      </header>

      {decisionBlocked && <DecisionBlockedBanner />}

      <div className="mt-4">
        <Tabs
          ariaLabel="Candidate sections"
          items={[
            {
              id: 'overview',
              label: 'Overview',
              panel: (
                <ScopedOverviewTab
                  candidate={candidate}
                  sessions={sessions}
                  applicationLinkId={applicationLinkId!}
                />
              ),
            },
            {
              id: 'review',
              label: 'Review',
              panel: (
                <TranscriptionSyncWorkspace
                  sessions={sessions}
                  assessments={assessments}
                  blocked={decisionBlocked}
                />
              ),
            },
          ]}
        />
      </div>
    </main>
  );
}

/** Overview, read-only: profile + sessions + notes. No actions, no backlinks. */
function ScopedOverviewTab({
  candidate,
  sessions,
  applicationLinkId,
}: {
  candidate: CandidateDetail['candidate'];
  sessions: CandidateDetail['sessions'];
  applicationLinkId: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <CandidateProfileCard candidate={candidate} />
      <div className="space-y-6 lg:col-span-2">
        {/* The SAME read-only card as the normal Overview, read through the
            SAME link scope this shell already uses. No new access, no new
            navigation — the API resolves the candidate server-side. */}
        <AshbyWorkflowCard source={{ kind: 'applicationLink', applicationLinkId }} />

        <SessionsSummary
          sessions={sessions}
          linkToSession={false}
          emptyLabel="No screening sessions yet."
        />
        <ScopedNotesCard applicationLinkId={applicationLinkId} />
      </div>
    </div>
  );
}

function ScopedNotesCard({ applicationLinkId }: { applicationLinkId: string }) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listAshbyScopedReviewNotes(applicationLinkId)
      .then((r) => {
        if (!cancelled) setNotes(r.notes);
      })
      .catch((e: ApiError) => {
        if (!cancelled) setErr(e.status === 404 || e.status === 403 ? UNAVAILABLE : e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [applicationLinkId]);

  return (
    <Card className="p-5">
      <h2 className="mb-3 text-sm font-semibold text-ink">Notes</h2>
      <NotesList notes={notes} error={err} />
    </Card>
  );
}
