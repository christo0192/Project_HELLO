/**
 * TranscriptionSyncWorkspace — the ONE unified candidate review workspace.
 *
 * A single authoritative place to review a completed screening session:
 *   - session context header (date, mode, duration, status)
 *   - one on-demand RecordingPlayer (single <audio>, signed URL minted only
 *     on explicit action)
 *   - a synchronized SeekableTranscript (click a timed turn to seek+play;
 *     the active turn tracks playback)
 *   - the scorecard for THAT session
 *
 * This replaces the previously duplicated recording/transcript/scorecard
 * presentations on the candidate page. All three artifacts come from a single
 * `GET /api/screening/:id` load, so they always correspond to the selected
 * session.
 *
 * Access: `GET /api/screening/:id` is admin-only. For non-admin reviewers the
 * transcript/recording load returns 403; we degrade gracefully — showing a
 * truthful note plus the candidate's latest scorecard (from the viewer-visible
 * candidate detail) instead of an error.
 *
 * Sync logic:
 *   1. Click a timed turn → if URL not loaded, mint it, queue the offset, wait
 *      for readiness, then seek + play (latest offset wins on rapid clicks).
 *   2. audio timeupdate → nearest turn by start_offset_sec → highlight.
 *   3. Selecting a new session resets everything; stale loads are discarded.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import type { Assessment, Session, TranscriptLine } from '../../types';
import {
  CandidateErrorState,
  CandidateSelect,
  StatusBadge,
  SurfaceCard,
} from '../design';
import { CandidateScorecard } from './CandidateScorecard';
import { RecordingPlayer } from './RecordingPlayer';
import type { RecordingPlayerHandle } from './RecordingPlayer';
import { SeekableTranscript } from './SeekableTranscript';
import {
  formatDurationSec,
  sessionStatusLabel,
  sessionStatusTone,
} from './status';
import { formatDateTime } from '../../lib/datetime';
import { isLiveVoiceMode, sessionModeLabel } from '../../lib/session-mode';

export interface TranscriptionSyncWorkspaceProps {
  sessions: Session[];
  assessments: Assessment[];
  blocked: boolean;
}

function findActiveTurnIndex(
  turns: TranscriptLine[],
  currentTime: number,
  toleranceSec = 0.25,
): number | null {
  let active: number | null = null;
  for (let i = 0; i < turns.length; i++) {
    const offset = turns[i].start_offset_sec;
    if (offset != null && offset <= currentTime + toleranceSec) {
      active = i;
    }
  }
  return active;
}

export function TranscriptionSyncWorkspace({
  sessions,
  assessments,
  blocked,
}: TranscriptionSyncWorkspaceProps) {
  const selectableSessions = useMemo(
    () => sessions.filter((s) => s.status === 'completed'),
    [sessions],
  );

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    () => selectableSessions[0]?.id ?? null,
  );
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [sessionAssessment, setSessionAssessment] = useState<Assessment | null>(null);
  const [loadedSession, setLoadedSession] = useState<Session | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [activeTurnIndex, setActiveTurnIndex] = useState<number | null>(null);

  // refreshKey counter for retry — changing it re-triggers the effect
  const [refreshKey, setRefreshKey] = useState(0);

  const playerRef = useRef<RecordingPlayerHandle>(null);

  const selectedSession = useMemo(
    () => selectableSessions.find((s) => s.id === selectedSessionId) ?? null,
    [selectableSessions, selectedSessionId],
  );

  // Load transcript + assessment + session meta when session/refreshKey changes
  const loadTranscript = useCallback((sessionId: string) => {
    let cancelled = false;
    setTranscriptLoading(true);
    setTranscriptError(null);
    setPermissionDenied(false);
    setTranscript([]);
    setSessionAssessment(null);
    setLoadedSession(null);
    setActiveTurnIndex(null);

    api
      .getSession(sessionId)
      .then((detail) => {
        if (cancelled) return;
        setTranscript(detail.transcript);
        setSessionAssessment(detail.assessment ?? null);
        setLoadedSession(detail.session ?? null);
        setTranscriptLoading(false);
      })
      .catch((e: ApiError) => {
        if (cancelled) return;
        // Non-admin reviewers cannot read the per-session transcript; degrade
        // gracefully rather than surfacing a raw error.
        if (e.status === 403) {
          setPermissionDenied(true);
          setTranscriptLoading(false);
          return;
        }
        setTranscriptError(e.message || 'Failed to load transcript');
        setTranscriptLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // If the sessions prop changes (candidate reload) and the selected session
  // is no longer completable, fall back to the first available one so the
  // <select> never shows a blank value and the effect never fetches a session
  // that has vanished from the list.
  useEffect(() => {
    if (
      selectedSessionId &&
      !selectableSessions.some((s) => s.id === selectedSessionId)
    ) {
      setSelectedSessionId(selectableSessions[0]?.id ?? null);
    }
  }, [selectableSessions, selectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId) {
      setTranscript([]);
      setTranscriptError(null);
      setPermissionDenied(false);
      setActiveTurnIndex(null);
      return;
    }
    return loadTranscript(selectedSessionId);
  }, [selectedSessionId, refreshKey, loadTranscript]);

  const handleTimeUpdate = useCallback(
    (currentTime: number) => {
      setActiveTurnIndex(findActiveTurnIndex(transcript, currentTime));
    },
    [transcript],
  );

  // click-to-play contract — RecordingPlayer owns mint/wait/seek/play.
  const handleSeek = useCallback((offsetSec: number) => {
    playerRef.current?.playFrom(offsetSec);
  }, []);

  const handleTranscriptRetry = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const handleSessionChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedSessionId(e.target.value || null);
  }, []);

  // The scorecard shown is the selected session's own assessment when
  // available; for non-admins it falls back to the candidate's latest.
  const scorecardAssessment = sessionAssessment ?? (permissionDenied ? assessments[0] ?? null : null);

  if (selectableSessions.length === 0) {
    return (
      <div className="space-y-6">
        <SurfaceCard className="p-4 sm:p-5">
          <h2 className="mb-1 text-sm font-semibold text-[var(--c-ink)]">
            Review workspace
          </h2>
          <p className="max-w-prose text-sm leading-relaxed text-[var(--c-ink-secondary)]">
            No completed sessions with recordings yet. Complete a live voice
            screening to review the transcript with synchronized playback and
            the session scorecard here.
          </p>
        </SurfaceCard>
        <ScorecardBlock
          blocked={blocked}
          assessment={assessments[0] ?? null}
          heading={assessments.length > 0 ? 'Latest scorecard' : undefined}
        />
      </div>
    );
  }

  const contextSession = loadedSession ?? selectedSession;

  return (
    <div className="space-y-6">
      {/* Session selector + context */}
      <SurfaceCard className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <label
            htmlFor="sync-session-select"
            className="text-sm font-medium text-[var(--c-ink)]"
          >
            Session
          </label>
          <CandidateSelect
            id="sync-session-select"
            value={selectedSessionId ?? ''}
            onChange={handleSessionChange}
          >
            {selectableSessions.map((s) => (
              <option key={s.id} value={s.id}>
                {formatDateTime(s.created_at, { month: 'short', day: 'numeric', year: 'numeric' })}
                {' — '}
                {s.id.slice(0, 8)}
                {isLiveVoiceMode(s.mode) ? ' (live)' : ''}
              </option>
            ))}
          </CandidateSelect>
        </div>
        {contextSession && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--c-ink-muted)]">
            <StatusBadge tone={sessionStatusTone(contextSession.status)}>
              {sessionStatusLabel(contextSession.status)}
            </StatusBadge>
            <span>{sessionModeLabel(contextSession.mode)}</span>
            <span aria-hidden>·</span>
            <span>{formatDurationSec(contextSession.duration_sec)}</span>
            <span aria-hidden>·</span>
            <span>{formatDateTime(contextSession.created_at)}</span>
          </div>
        )}
      </SurfaceCard>

      {permissionDenied ? (
        <SurfaceCard className="p-4 sm:p-5">
          <h2 className="mb-1 text-sm font-semibold text-[var(--c-ink)]">
            Transcript &amp; recording
          </h2>
          <p className="max-w-prose text-sm leading-relaxed text-[var(--c-ink-secondary)]">
            Detailed transcript playback and recording review require admin
            access. The session scorecard is shown below.
          </p>
        </SurfaceCard>
      ) : (
        /* Split pane: sticky player + scrollable transcript */
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
          <div id="sync-workspace-player" className="lg:sticky lg:top-4 lg:w-80 lg:shrink-0 [&_audio]:w-full">
            {selectedSessionId && (
              <RecordingPlayer
                ref={playerRef}
                sessionId={selectedSessionId}
                onTimeUpdate={handleTimeUpdate}
                compact={false}
              />
            )}
            <a
              href="#sync-transcript-region"
              className="sr-only focus:not-sr-only focus:mt-2 focus:inline-block focus:text-xs focus:text-[var(--c-accent)]"
            >
              Skip to transcript
            </a>
            <p className="mt-2 hidden max-w-prose text-xs text-[var(--c-ink-secondary)] lg:block">
              Click any timed transcript turn to jump to that moment. Active
              turns are highlighted automatically during playback.
            </p>
          </div>

          <div id="sync-transcript-region" className="min-h-0 flex-1">
            {transcriptError ? (
              <CandidateErrorState
                message={transcriptError}
                onRetry={handleTranscriptRetry}
              />
            ) : (
              <SeekableTranscript
                transcript={transcript}
                activeTurnIndex={activeTurnIndex}
                onSeek={handleSeek}
                recordingReady={true}
                isLoading={transcriptLoading}
                onRetry={handleTranscriptRetry}
              />
            )}
          </div>
        </div>
      )}

      {!permissionDenied && (
        <a
          href="#sync-workspace-player"
          className="sr-only focus:not-sr-only focus:inline-block focus:text-xs focus:text-[var(--c-accent)]"
        >
          Return to recording player
        </a>
      )}

      {/* Scorecard for the selected session */}
      <ScorecardBlock
        blocked={blocked}
        assessment={scorecardAssessment}
        heading={
          sessionAssessment
            ? 'Scorecard for this session'
            : permissionDenied && scorecardAssessment
              ? 'Latest scorecard'
              : undefined
        }
      />
    </div>
  );
}

/* ── Scorecard block ──────────────────────────────────────────────── */

function ScorecardBlock({
  blocked,
  assessment,
  heading,
}: {
  blocked: boolean;
  assessment: Assessment | null;
  heading?: string;
}) {
  const headingId = useId();
  // A plain section, not a card: the scorecard's own sections are the first
  // card level and their sunken blocks the second, so wrapping the whole
  // thing in another card would make three — the nesting the owner flagged.
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="mb-3 text-sm font-semibold text-[var(--c-ink)]">
        {heading ?? 'Scorecard'}
      </h2>
      {blocked ? (
        <p className="max-w-prose text-sm leading-relaxed text-[var(--c-ink-secondary)]">
          Scorecards are suppressed while an appeal is under review.
        </p>
      ) : assessment ? (
        <CandidateScorecard assessment={assessment} />
      ) : (
        <p className="max-w-prose text-sm leading-relaxed text-[var(--c-ink-secondary)]">
          No scorecard for this session yet — complete a screening to generate
          one.
        </p>
      )}
    </section>
  );
}
