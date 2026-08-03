/**
 * HELLO Session Detail — read-only post-session view (Lane 3).
 *
 * Uses the existing `GET /api/screening/:id` contract
 * (`SessionDetail = { session, transcript, assessment }`):
 *
 *   - Transcript: speaker turns only — the API contract has no timestamps,
 *     so none are fabricated.
 *   - Scorecard: rendered from the returned `assessment` via <Scorecard>.
 *   - Recording: authorized short-lived player/download via
 *     `GET /api/recordings/:id/download` — fetched ONLY on an explicit click,
 *     refreshed on expiry, errors handled inline. The signed URL appears in
 *     the DOM only as the media href while active and is never logged.
 *
 * There is deliberately NO composer here: this is a review view, not a
 * live-screening console.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import type { SessionDetail } from '../types';
import { ErrorState, LoadingState, Card } from '../components/ui';
import { PageHeader, StatusBadge } from '../components/design';
import { RecordingCard, TranscriptList } from '../components/talent';
import {
  formatDurationSec,
  sessionStatusLabel,
  sessionStatusTone,
} from '../components/talent';
import { Scorecard } from '../components/Scorecard';

export function SessionDetailPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!sessionId) return;
    setError(null);
    setDetail(null);
    api
      .getSession(sessionId)
      .then(setDetail)
      .catch((e: ApiError) => setError(e.message));
  }, [sessionId]);

  useEffect(load, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!detail) return <LoadingState label="Loading session…" />;

  const { session, transcript, assessment } = detail;
  const completed = session.status === 'completed';

  return (
    <div>
      <Link
        to={`/candidates/${session.candidate_id}`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-ink-secondary hover:text-ink"
      >
        ← Back to candidate
      </Link>

      <PageHeader
        eyebrow="Session"
        title={`Session ${session.id.slice(0, 8)}`}
        description={`${session.mode === 'live' ? 'Live voice screening' : 'Simulation screening'} · created ${new Date(session.created_at).toLocaleString()}`}
        actions={<StatusBadge tone={sessionStatusTone(session.status)}>{sessionStatusLabel(session.status)}</StatusBadge>}
      />

      <p className="mb-6 rounded-lg border border-line bg-surface-secondary px-4 py-3 text-xs text-ink-secondary">
        This is a read-only view of the completed session. Transcript and
        scorecard are final; recordings are served through short-lived links
        created on request.
      </p>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Transcript */}
        <Card className="p-5 lg:col-span-2">
          <h2 className="mb-1 text-sm font-semibold text-ink">Transcript</h2>
          <p className="mb-4 text-xs text-ink-tertiary">
            {transcript.length} speaker turn{transcript.length === 1 ? '' : 's'}
          </p>
          <TranscriptList transcript={transcript} />
        </Card>

        {/* Session meta */}
        <Card className="h-fit p-5">
          <h2 className="mb-4 text-sm font-semibold text-ink">Session details</h2>
          <dl className="space-y-3 text-sm">
            <MetaField label="Status">
              <StatusBadge tone={sessionStatusTone(session.status)}>
                {sessionStatusLabel(session.status)}
              </StatusBadge>
            </MetaField>
            <MetaField label="Mode">
              {session.mode === 'live' ? 'Live voice' : 'Simulation'}
            </MetaField>
            <MetaField label="Duration">
              {formatDurationSec(session.duration_sec)}
            </MetaField>
            <MetaField label="Started">
              {new Date(session.created_at).toLocaleString()}
            </MetaField>
            <div className="pt-1">
              <dt className="mb-1 text-xs font-medium text-ink-secondary">Session ID</dt>
              <dd className="break-all font-mono text-xs text-ink-tertiary">{session.id}</dd>
            </div>
          </dl>
        </Card>

        {/* Scorecard */}
        <Card className="p-5 lg:col-span-2">
          <h2 className="mb-4 text-sm font-semibold text-ink">Scorecard</h2>
          {assessment ? (
            <Scorecard assessment={assessment} />
          ) : completed ? (
            <p className="rounded-lg border border-dashed border-line-strong bg-surface-secondary px-4 py-8 text-center text-sm text-ink-secondary">
              No scorecard yet — assessment generation may still be running.
            </p>
          ) : (
            <p className="rounded-lg border border-dashed border-line-strong bg-surface-secondary px-4 py-8 text-center text-sm text-ink-secondary">
              No scorecard — the session has not completed.
            </p>
          )}
        </Card>

        {/* Recording — authorized on-demand access */}
        <Card className="h-fit p-5">
          <h2 className="mb-1 text-sm font-semibold text-ink">Recording</h2>
          {completed ? (
            <RecordingCard sessionId={session.id} title="Session recording" />
          ) : (
            <p className="text-sm text-ink-tertiary">
              Recording access is available once the session completes.
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}

function MetaField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-xs font-medium text-ink-secondary">{label}</dt>
      <dd className="text-right text-ink">{children}</dd>
    </div>
  );
}
