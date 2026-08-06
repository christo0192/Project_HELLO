/**
 * TranscriptionSyncWorkspace — recording player + transcript sync workspace.
 *
 * Renders a split-pane layout within the "Transcript & Scorecards" tab:
 *   - Left: sticky RecordingPlayer (on-demand signed URL, single <audio>)
 *   - Right: scrollable SeekableTranscript with session selector
 *   - Below: Scorecards (collapsible)
 *
 * Desktop (>=1024px): side-by-side (320px sticky player, flex-1 transcript)
 * Mobile (<1024px): compact sticky player bar at top, transcript below
 *
 * Sync logic:
 *   1. User clicks a timed transcript turn → if URL not loaded, mint it,
 *      queue the offset, wait for canplay, then seek+play.
 *      If already loaded, seek+play immediately.
 *      Last queued offset wins on rapid clicks.
 *   2. audio timeupdate → find nearest turn by start_offset_sec → highlight
 *   3. Selecting a new session resets everything; stale loads are discarded.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import type { Assessment, Session, TranscriptLine } from '../../types';
import { Card, ErrorState } from '../ui';
import { Scorecard } from '../Scorecard';
import { RecordingPlayer } from './RecordingPlayer';
import type { RecordingPlayerHandle } from './RecordingPlayer';
import { SeekableTranscript } from './SeekableTranscript';

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
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [activeTurnIndex, setActiveTurnIndex] = useState<number | null>(null);

  // P1-1: refreshKey counter for retry — changing it re-triggers the effect
  const [refreshKey, setRefreshKey] = useState(0);

  const playerRef = useRef<RecordingPlayerHandle>(null);

  // Load transcript when session or refreshKey changes
  const loadTranscript = useCallback((sessionId: string) => {
    let cancelled = false;
    setTranscriptLoading(true);
    setTranscriptError(null);
    setTranscript([]);
    setActiveTurnIndex(null);

    api
      .getSession(sessionId)
      .then((detail) => {
        if (cancelled) return;
        setTranscript(detail.transcript);
        setTranscriptLoading(false);
      })
      .catch((e: ApiError) => {
        if (cancelled) return;
        setTranscriptError(e.message || 'Failed to load transcript');
        setTranscriptLoading(false);
      });

    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!selectedSessionId) {
      setTranscript([]);
      setTranscriptError(null);
      setActiveTurnIndex(null);
      return;
    }
    return loadTranscript(selectedSessionId);
  }, [selectedSessionId, refreshKey, loadTranscript]);

  // timeupdate → active turn
  const handleTimeUpdate = useCallback(
    (currentTime: number) => {
      const idx = findActiveTurnIndex(transcript, currentTime);
      setActiveTurnIndex(idx);
    },
    [transcript],
  );

  // P0-1: click-to-play contract. The RecordingPlayer owns the full
  // lifecycle — mint the short-lived URL on demand, wait for the <audio> to
  // mount and reach readiness, then seek + play — so a transcript click made
  // BEFORE the recording is loaded works, and the latest offset wins on rapid
  // clicks. Session-change resets inside RecordingPlayer discard stale seeks.
  const handleSeek = useCallback((offsetSec: number) => {
    playerRef.current?.playFrom(offsetSec);
  }, []);

  // P1-1: working retry — increments refreshKey to re-trigger the effect
  const handleTranscriptRetry = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  // Older assessments (latest is on Overview tab)
  const olderAssessments = assessments.slice(1);

  const handleSessionChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedSessionId(e.target.value || null);
    // RecordingPlayer resets its own URL + queued seek when sessionId changes.
  }, []);

  if (selectableSessions.length === 0) {
    return (
      <div className="space-y-6">
        <Card className="p-5">
          <h2 className="mb-1 text-sm font-semibold text-ink">
            Transcript &amp; Recording
          </h2>
          <p className="text-sm text-ink-secondary">
            No completed sessions with recordings yet. Complete a live voice
            screening to review transcripts with synchronized playback.
          </p>
        </Card>
        <ScorecardsBlock assessments={olderAssessments} blocked={blocked} fallback={assessments.length > 0 ? 'latest-on-overview' : 'none'} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Session selector */}
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="sync-session-select" className="text-sm font-medium text-ink">
          Session
        </label>
        <select
          id="sync-session-select"
          value={selectedSessionId ?? ''}
          onChange={handleSessionChange}
          className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        >
          {selectableSessions.map((s) => (
            <option key={s.id} value={s.id}>
              {new Date(s.created_at).toLocaleDateString()} — {s.id.slice(0, 8)}
              {s.mode === 'live' ? ' (live)' : ''}
              {s.duration_sec ? ` · ${Math.round(s.duration_sec / 60)}m` : ''}
            </option>
          ))}
        </select>
      </div>

      {/* Split pane */}
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        {/* LEFT — sticky player (compact on mobile, full on desktop) */}
        {/* P1-3: mobile bar is sticky; desktop full panel */}
        <div className="lg:sticky lg:top-4 lg:w-80 lg:shrink-0 [&_audio]:w-full">
          {selectedSessionId && (
            <RecordingPlayer
              ref={playerRef}
              sessionId={selectedSessionId}
              onTimeUpdate={handleTimeUpdate}
              compact={false}
            />
          )}
          {/* P2-2: hidden skip-link anchor to return to transcript */}
          <a
            href="#sync-transcript-region"
            className="sr-only focus:not-sr-only focus:inline-block focus:mt-2 focus:text-xs focus:text-brand-600"
          >
            Skip to transcript
          </a>
          <p className="mt-2 hidden text-xs text-ink-tertiary lg:block">
            Click any timed transcript turn to jump to that moment. Active
            turns are highlighted automatically during playback.
          </p>
        </div>

        {/* RIGHT — scrollable transcript */}
        <div id="sync-transcript-region" className="min-h-0 flex-1">
          {transcriptError ? (
            <ErrorState
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

      {/* P2-2: skip link back to player */}
      <a
        href="#sync-workspace-audio"
        className="sr-only focus:not-sr-only focus:inline-block focus:text-xs focus:text-brand-600"
      >
        Return to recording player
      </a>

      {/* Scorecards */}
      <ScorecardsBlock assessments={olderAssessments} blocked={blocked} fallback={assessments.length > 0 ? 'latest-on-overview' : 'none'} />
    </div>
  );
}

/* ── Scorecards block ──────────────────────────────────────────── */

function ScorecardsBlock({
  assessments,
  blocked,
  fallback,
}: {
  assessments: Assessment[];
  blocked: boolean;
  fallback: 'latest-on-overview' | 'none';
}) {
  return (
    <Card className="p-5">
      <h2 className="mb-3 text-sm font-semibold text-ink">Scorecards</h2>
      {blocked ? (
        <p className="text-sm text-ink-secondary">
          Scorecards are suppressed while an appeal is under review.
        </p>
      ) : assessments.length === 0 ? (
        <p className="text-sm text-ink-secondary">
          {fallback === 'latest-on-overview'
            ? 'The latest scorecard is shown on the Overview tab. No older scorecards exist yet.'
            : 'No scorecards yet — complete a screening to generate one.'}
        </p>
      ) : (
        <div className="space-y-6">
          {assessments.map((a) => (
            <Scorecard key={a.id ?? a.overall_score} assessment={a} />
          ))}
        </div>
      )}
    </Card>
  );
}
