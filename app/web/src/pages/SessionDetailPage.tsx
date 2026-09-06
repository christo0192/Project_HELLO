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
import {
  buttonClass,
  ErrorPanel,
  GlassPanel,
  LoadingPanel,
  PageHeader,
  ScrollArea,
  SectionHeader,
  StatusBadge,
} from '../components/design';
import { RecordingCard, TranscriptList } from '../components/talent';
import {
  formatDurationSec,
  sessionStatusLabel,
  sessionStatusTone,
} from '../components/talent';
import { Scorecard } from '../components/Scorecard';
import { formatDateTime } from '../lib/datetime';
import { sessionModeLabel } from '../lib/session-mode';

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

  if (error) return <ErrorPanel message={error} onRetry={load} />;
  if (!detail) return <LoadingPanel label="Loading session…" />;

  const { session, transcript, assessment } = detail;
  const completed = session.status === 'completed';

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Session"
        title={`Session ${session.id.slice(0, 8)}`}
        description={`${sessionModeLabel(session.mode)} screening · created ${formatDateTime(session.created_at)}`}
        actions={
          <Link
            to={`/candidates/${session.candidate_id}`}
            className={buttonClass('secondary', 'sm')}
          >
            ← Back to candidate
          </Link>
        }
      />

      <p className="glass-sunken px-4 py-3 text-[13px] leading-5 text-ink-secondary">
        This is a read-only view of the completed session. Transcript and
        scorecard are final; recordings are served through short-lived links
        created on request.
      </p>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Transcript */}
        <GlassPanel className="lg:col-span-7">
          <SectionHeader
            title="Transcript"
            description={`${transcript.length} speaker turn${transcript.length === 1 ? '' : 's'}`}
          />
          {/* `TranscriptList` already exposes a region named "Transcript";
              this scroll region needs a distinct name (axe landmark-unique). */}
          <ScrollArea maxHeight="34rem" label="Session transcript" className="mt-3">
            <TranscriptList transcript={transcript} />
          </ScrollArea>
        </GlassPanel>

        <div className="space-y-6 lg:col-span-5">
          {/* Session meta */}
          <GlassPanel>
            <SectionHeader title="Session details" />
            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 text-sm">
              <MetaField label="Status">
                <StatusBadge tone={sessionStatusTone(session.status)}>
                  {sessionStatusLabel(session.status)}
                </StatusBadge>
              </MetaField>
              <MetaField label="Mode">
                {sessionModeLabel(session.mode)}
              </MetaField>
              <MetaField label="Duration">
                {formatDurationSec(session.duration_sec)}
              </MetaField>
              <MetaField label="Started">
                {formatDateTime(session.started_at ?? session.created_at)}
              </MetaField>
              <dt className="text-[13px] text-ink-tertiary">Session ID</dt>
              <dd className="break-all text-right font-mono text-xs text-ink-secondary">
                {session.id}
              </dd>
            </dl>
          </GlassPanel>

          {/* Recording — authorized on-demand access */}
          <GlassPanel>
            <SectionHeader title="Recording" />
            <div className="mt-4">
              {completed ? (
                <RecordingCard sessionId={session.id} title="Session recording" />
              ) : (
                <p className="text-sm text-ink-tertiary">
                  Recording access is available once the session completes.
                </p>
              )}
            </div>
          </GlassPanel>
        </div>
      </div>

      <div className="mt-6">
      {/* Scorecard */}
      <GlassPanel>
        <SectionHeader title="Scorecard" />
        <div className="mt-4">
          {assessment ? (
            <Scorecard assessment={assessment} />
          ) : completed ? (
            <p className="glass-sunken px-4 py-8 text-center text-sm text-ink-secondary">
              No scorecard yet — assessment generation may still be running.
            </p>
          ) : (
            <p className="glass-sunken px-4 py-8 text-center text-sm text-ink-secondary">
              No scorecard — the session has not completed.
            </p>
          )}
        </div>
      </GlassPanel>
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
    <>
      <dt className="text-[13px] text-ink-tertiary">{label}</dt>
      <dd className="text-right text-sm text-ink">{children}</dd>
    </>
  );
}
