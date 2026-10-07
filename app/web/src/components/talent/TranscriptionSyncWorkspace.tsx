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
 *
 * Phone sessions (M013 S02): a phone session can span several LEGS (the first
 * call, then reconnects after a drop), each with its own recording file. When
 * the host passes `candidateId`, a phone session lists EVERY leg in order —
 * which call it was, when it was connected, how much was recorded, the
 * "end not observed" and "may end early" notes — each with its own player
 * minted on click. The transcript is grouped by leg, and a click seeks within
 * THAT leg's file (`recording_started_at_ms`; a legacy leg falls back to its
 * answer time + 1 s and its times read "≈"). If no leg can be played, the
 * session recording player is kept and turns seek it as before.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import { readScorecardAssessmentV2, isAssessmentV2 } from '../../types';
import type {
  Assessment,
  CandidatePhoneAttempt,
  ResumeConflict,
  RoleFitScore,
  Session,
  TranscriptLine,
} from '../../types';
import { StatusBadge } from '../design';
import {
  CandidateErrorState,
  CandidateSelect,
  SurfaceCard,
} from '../design/candidate';
import {
  CandidateScorecard,
  CandidateScorecardNarrative,
  CandidateScorecardRoleFit,
} from './CandidateScorecard';
import { CandidateScorecardV2 } from './CandidateScorecardV2';
import { EvidenceHoldNotice } from './EvidenceHoldNotice';
import { RecordingPlayer } from './RecordingPlayer';
import type { RecordingPlayerHandle } from './RecordingPlayer';
import { SeekableTranscript } from './SeekableTranscript';
import { SessionLegRow } from './SessionLegRow';
import {
  activeTurnIn,
  groupTurnsByLeg,
  legPlayable,
  legTitle,
  sessionLengthLabel,
  sortLegs,
} from './sessionLegs';
import type { LegGroup, LegSeekMode } from './sessionLegs';
import {
  sessionStatusLabel,
  sessionStatusTone,
} from './status';
import { formatDateTime } from '../../lib/datetime';
import { sessionModeLabel } from '../../lib/session-mode';

/** One leg page is plenty (a session has a handful of legs); follow a few. */
const LEG_PAGE_SIZE = 50;
const LEG_PAGES_MAX = 4;

type LegsState =
  | { sessionId: string; status: 'loading' }
  | { sessionId: string; status: 'ready'; legs: CandidatePhoneAttempt[] }
  | { sessionId: string; status: 'error' };

/** The playing turn in the grouped view: its group key and row. */
interface ActiveLegTurn {
  key: number;
  index: number;
}

/** `legIndex`, or -1 for the "no timing" bucket. */
const groupKey = (g: LegGroup) => g.legIndex ?? -1;

export interface TranscriptionSyncWorkspaceProps {
  sessions: Session[];
  assessments: Assessment[];
  blocked: boolean;
  /**
   * M013 S02: the candidate whose phone legs to list (`/phone-attempts`
   * filtered to the selected session). A host that omits it — the scoped
   * Ashby page, whose reduced API adapter may not offer the route — keeps the
   * single session player.
   */
  candidateId?: string;
  /**
   * Shown under the empty state when no session has completed: the
   * candidate's per-call recordings (calls that ended early, including at the
   * consent step). A slot rather than a candidate id so this component stays
   * free of a second data path; the Ashby scoped page passes nothing and is
   * unchanged. The host shares one attempt list between this copy and the
   * Overview's, so the Review tab never fetches it a second time.
   */
  callRecordings?: React.ReactNode;
}

/** Résumé conflicts, whether they arrive on the column or (rarely) inside raw. */
function resumeConflictsOf(a: Assessment): ResumeConflict[] {
  const raw = a.raw as { resume_conflicts?: ResumeConflict[] } | null | undefined;
  const list = a.resume_conflicts ?? raw?.resume_conflicts;
  return Array.isArray(list) ? list : [];
}

/** Null-safe: a role_fit worth rendering has at least one tag or a note. */
function roleFitHasContent(rf: RoleFitScore | null | undefined): boolean {
  if (!rf || typeof rf !== 'object') return false;
  const filled = (x: unknown) => Array.isArray(x) && x.length > 0;
  return (
    filled(rf.matched_skills) ||
    filled(rf.gaps) ||
    filled(rf.red_flags) ||
    (typeof rf.notes === 'string' && rf.notes.trim().length > 0)
  );
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
  candidateId,
  callRecordings,
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
  const transcriptHeadingId = useId();

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
    const stillPresent =
      selectedSessionId != null && selectableSessions.some((s) => s.id === selectedSessionId);
    if (stillPresent) return;
    // Also covers mounting with zero completed sessions: the first one that
    // arrives later (a call that just finished) is adopted automatically.
    const next = selectableSessions[0]?.id ?? null;
    if (next !== selectedSessionId) setSelectedSessionId(next);
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

  /* ── Phone legs (M013 S02) ─────────────────────────────────── */

  const legsEnabled =
    !!candidateId &&
    selectedSession?.mode === 'live' &&
    typeof api.getCandidatePhoneAttempts === 'function';
  const [legsState, setLegsState] = useState<LegsState | null>(null);
  const [legsRefreshKey, setLegsRefreshKey] = useState(0);
  const [activeLegTurn, setActiveLegTurn] = useState<ActiveLegTurn | null>(null);
  const legPlayers = useRef(new Map<string, RecordingPlayerHandle>());

  useEffect(() => {
    setActiveLegTurn(null);
    if (!legsEnabled || !candidateId || !selectedSessionId) {
      setLegsState(null);
      return;
    }
    let cancelled = false;
    const sessionId = selectedSessionId;
    setLegsState({ sessionId, status: 'loading' });
    (async () => {
      const all: CandidatePhoneAttempt[] = [];
      let before: string | undefined;
      for (let page = 0; page < LEG_PAGES_MAX; page++) {
        const res = await api.getCandidatePhoneAttempts(candidateId, before, {
          sessionId,
          limit: LEG_PAGE_SIZE,
        });
        all.push(...res.attempts);
        if (!res.next_cursor) break;
        before = res.next_cursor;
      }
      return all;
    })()
      .then((all) => {
        if (!cancelled) setLegsState({ sessionId, status: 'ready', legs: sortLegs(all) });
      })
      .catch(() => {
        if (!cancelled) setLegsState({ sessionId, status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [legsEnabled, candidateId, selectedSessionId, legsRefreshKey]);

  // The legs of THIS session only: a response for the previous selection is
  // never shown against the next one.
  const currentLegs = legsState && legsState.sessionId === selectedSessionId ? legsState : null;
  const legsLoading = legsEnabled && (currentLegs === null || currentLegs.status === 'loading');
  const legsFailed = legsEnabled && currentLegs?.status === 'error';
  const legs = useMemo(
    () => (currentLegs?.status === 'ready' ? currentLegs.legs : []),
    [currentLegs],
  );
  const legsMode = legs.length > 0;
  const seekMode: LegSeekMode = legs.some(legPlayable) ? 'leg' : 'session';
  // The session player stays whenever no leg can be played (or there are no
  // legs to list): an egress-era session's recording lives on the session.
  const showSessionPlayer = !legsLoading && (!legsMode || seekMode === 'session');

  const legGroups = useMemo(
    () =>
      legsMode
        ? groupTurnsByLeg(transcript, legs, loadedSession?.recording_egress_started_at_ms, seekMode)
        : [],
    [legsMode, transcript, legs, loadedSession, seekMode],
  );

  const handleTimeUpdate = useCallback(
    (currentTime: number) => {
      if (legsMode) {
        // Session seek mode: every group carries session offsets, so the
        // playing turn is the last one (in reading order) at or before t.
        let found: ActiveLegTurn | null = null;
        for (const g of legGroups) {
          const index = activeTurnIn(g.turns, currentTime);
          if (index !== null) found = { key: groupKey(g), index };
        }
        setActiveLegTurn(found);
        return;
      }
      setActiveTurnIndex(findActiveTurnIndex(transcript, currentTime));
    },
    [transcript, legsMode, legGroups],
  );

  // click-to-play contract — RecordingPlayer owns mint/wait/seek/play.
  const handleSeek = useCallback((offsetSec: number) => {
    playerRef.current?.playFrom(offsetSec);
  }, []);

  /** A leg's playhead moved: highlight within that leg's group only. */
  const handleLegTimeUpdate = useCallback(
    (legIndex: number, currentTime: number) => {
      const group = legGroups.find((g) => g.legIndex === legIndex);
      const index = group ? activeTurnIn(group.turns, currentTime) : null;
      setActiveLegTurn(index === null ? null : { key: legIndex, index });
    },
    [legGroups],
  );

  /** One leg plays at a time: starting one pauses the others. */
  const handleLegPlayState = useCallback((legId: string, playing: boolean) => {
    if (!playing) return;
    legPlayers.current.forEach((player, id) => {
      if (id !== legId) player.pause();
    });
  }, []);

  /** A turn click in a leg group seeks that leg's file (or the session's). */
  const handleGroupSeek = useCallback(
    (group: LegGroup, offsetSec: number) => {
      if (seekMode === 'session' || group.legIndex === null) {
        playerRef.current?.playFrom(offsetSec);
        return;
      }
      const leg = legs[group.legIndex];
      if (leg) legPlayers.current.get(leg.id)?.playFrom(offsetSec);
    },
    [seekMode, legs],
  );

  const handleTranscriptRetry = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const handleSessionChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedSessionId(e.target.value || null);
  }, []);

  // The scorecard shown is the selected session's own assessment when
  // available; for non-admins it falls back to the candidate's latest.
  const scorecardAssessment = sessionAssessment ?? (permissionDenied ? assessments[0] ?? null : null);

  const contextSession = loadedSession ?? selectedSession;
  const turnCount = transcript.length;

  /* The one frame every branch renders into. Left column: the transcript
     (or the branch's message) with the resume conflicts beneath it, so the
     space under a bounded transcript is used. Right column: verdict +
     signals. Beneath both, full width: Role fit as a horizontal row, then
     the summary. Neither column is sticky — with a real scorecard both run
     longer than a viewport, and a sticky column taller than the viewport
     never sticks. */
  const frame = (
    left: React.ReactNode,
    right: React.ReactNode,
    assessment: Assessment | null,
  ) => {
    // v1 shows the full legacy narrative (résumé conflicts, role fit, summary).
    // A v2 (role-scorecard) row historically carried none of these; since the
    // scorer was extended it now ALSO persists résumé conflicts + role fit (the
    // v1-shaped columns), so those two sections are shown for a v2 row too —
    // gated on the data actually being present, and null-safe for older v2 rows
    // that predate the change. The 1–10 `summary` remains v1-only.
    const isV2 = !blocked && !!assessment && isAssessmentV2(assessment);
    const legacyNarrative = !blocked && !!assessment && !isAssessmentV2(assessment);
    const showConflicts = !blocked && !!assessment && resumeConflictsOf(assessment).length > 0;
    const showV2RoleFit = isV2 && roleFitHasContent(assessment!.role_fit);
    return (
      <>
        <div className="grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-12 lg:items-start">
          <div className="min-w-0 space-y-4 sm:space-y-6 lg:col-span-7">
            {left}
            {/* headingLevel=2 so these read as top-level assessment sections,
                peers of "Transcript" and "Scorecard" — not a subsection of the
                transcript they happen to sit beneath in the DOM. */}
            {showConflicts && (
              <CandidateScorecardNarrative
                assessment={assessment!}
                parts="conflicts"
                headingLevel={2}
              />
            )}
          </div>
          <div className="min-w-0 lg:col-span-5">{right}</div>
        </div>
        {legacyNarrative && (
          <CandidateScorecardRoleFit assessment={assessment!} headingLevel={2} />
        )}
        {showV2RoleFit && (
          <CandidateScorecardRoleFit assessment={assessment!} supplementary headingLevel={2} />
        )}
        {legacyNarrative && (
          <CandidateScorecardNarrative assessment={assessment!} parts="summary" headingLevel={2} />
        )}
      </>
    );
  };

  if (selectableSessions.length === 0) {
    return (
      <div className="space-y-4 sm:space-y-6">
        {frame(
          <>
            <SurfaceCard className="p-4 sm:p-5">
              <h2 className="mb-1 text-[15px] font-semibold tracking-tight text-[var(--c-ink)]">
                Review workspace
              </h2>
              <p className="max-w-prose text-sm leading-relaxed text-[var(--c-ink-secondary)]">
                {callRecordings ? (
                  <>
                    No completed screening yet. Recordings of calls that ended
                    early are listed below; a completed screening shows its
                    transcript with synchronized playback and its scorecard here.
                  </>
                ) : (
                  <>
                    No completed sessions with recordings yet. Complete a live voice
                    screening to review the transcript with synchronized playback and
                    the session scorecard here.
                  </>
                )}
              </p>
            </SurfaceCard>
            {callRecordings}
          </>,
          <ScorecardBlock
            blocked={blocked}
            assessment={assessments[0] ?? null}
            heading={assessments.length > 0 ? 'Latest scorecard' : undefined}
          />,
          assessments[0] ?? null,
        )}
      </div>
    );
  }

  const transcriptPane = transcriptError ? (
    <SurfaceCard className="p-4 sm:p-5">
      <CandidateErrorState message={transcriptError} onRetry={handleTranscriptRetry} />
    </SurfaceCard>
  ) : (
    /* ONE card: title, the player as a toolbar row directly beneath it, then
       the transcript in a BOUNDED scroll region. The player used to be the
       only thing in a 20rem column, and the transcript ran to whatever length
       the session happened to be. */
    <SurfaceCard className="p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2
          id={transcriptHeadingId}
          className="text-[15px] font-semibold tracking-tight text-[var(--c-ink)]"
        >
          Transcript
        </h2>
        <span className="text-xs tabular-nums text-[var(--c-ink-secondary)]">
          {turnCount} {turnCount === 1 ? 'turn' : 'turns'}
        </span>
      </div>

      <div
        id="sync-workspace-player"
        className="mb-3 border-b border-[var(--c-border-light)] pb-3"
      >
        {selectedSessionId && legsLoading && (
          <p className="text-[13px] text-[var(--c-ink-secondary)]">Loading the calls in this session…</p>
        )}
        {selectedSessionId && legsMode && (
          /* Every leg of the session, in order, even when it completed. */
          <ol aria-label="Calls in this session" className="divide-y divide-[var(--c-border-light)]">
            {legs.map((leg, i) => (
              <SessionLegRow
                key={leg.id}
                ref={(handle) => {
                  if (handle) legPlayers.current.set(leg.id, handle);
                  else legPlayers.current.delete(leg.id);
                }}
                leg={leg}
                index={i}
                total={legs.length}
                sessionId={selectedSessionId}
                onTimeUpdate={(t) => handleLegTimeUpdate(i, t)}
                onPlayState={(playing) => handleLegPlayState(leg.id, playing)}
              />
            ))}
          </ol>
        )}
        {selectedSessionId && legsFailed && (
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1" role="alert">
            <p className="text-[13px] text-[var(--c-ink-secondary)]">
              The calls in this session could not be listed. The session recording is below.
            </p>
            <button
              type="button"
              onClick={() => setLegsRefreshKey((k) => k + 1)}
              className="text-xs font-medium text-[var(--c-accent)] underline-offset-2 hover:underline"
            >
              Retry
            </button>
          </div>
        )}
        {selectedSessionId && showSessionPlayer && (
          <div className={legsMode ? 'mt-3 border-t border-[var(--c-border-light)] pt-3' : undefined}>
            {legsMode && (
              <p className="mb-1 text-xs text-[var(--c-ink-secondary)]">
                No call above can be played on its own; the session recording follows.
              </p>
            )}
            <RecordingPlayer
              ref={playerRef}
              sessionId={selectedSessionId}
              onTimeUpdate={handleTimeUpdate}
            />
          </div>
        )}
        <a
          href="#sync-transcript-region"
          className="sr-only focus:not-sr-only focus:mt-2 focus:inline-block focus:text-xs focus:text-[var(--c-accent)]"
        >
          Skip to transcript
        </a>
      </div>

      {turnCount > 0 && (
        <p className="mb-2 text-xs text-[var(--c-ink-secondary)]">
          Click a timed turn to jump to that moment; the active turn is
          highlighted during playback.
        </p>
      )}

      <div
        id="sync-transcript-region"
        role="region"
        aria-label="Transcript"
        tabIndex={0}
        className="scroll-fade max-h-[36rem] overflow-y-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-accent)]"
      >
        {legsMode && !transcriptLoading && legGroups.length > 0 ? (
          /* Turns grouped by the call they were spoken in. */
          legGroups.map((group) => {
            const key = groupKey(group);
            const leg = group.legIndex === null ? null : legs[group.legIndex];
            const headingId = `${transcriptHeadingId}-leg-${key}`;
            return (
                <div key={key} role="group" aria-labelledby={headingId} className="mb-4 last:mb-0">
                  <h3
                    id={headingId}
                    className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--c-ink-secondary)]"
                  >
                    {leg && group.legIndex !== null
                      ? legTitle(group.legIndex, legs.length)
                      : 'Turns without timing'}
                  </h3>
                  {group.approximate && (
                    <p className="mb-2 text-xs text-[var(--c-ink-secondary)]">
                      Times in this call (≈) are estimated from when it was answered.
                    </p>
                  )}
                  {seekMode === 'leg' && leg && !legPlayable(leg) && (
                    <p className="mb-2 text-xs text-[var(--c-ink-secondary)]">
                      This call has no playable recording, so its turns cannot start playback.
                    </p>
                  )}
                  <SeekableTranscript
                    transcript={group.turns.map((t) => t.turn)}
                    turnNumbers={group.turns.map((t) => t.index + 1)}
                    activeTurnIndex={activeLegTurn?.key === key ? activeLegTurn.index : null}
                    onSeek={(offsetSec) => handleGroupSeek(group, offsetSec)}
                    recordingReady={true}
                    approximateTiming={group.approximate}
                  />
                </div>
            );
          })
        ) : (
          <SeekableTranscript
            transcript={transcript}
            activeTurnIndex={activeTurnIndex}
            onSeek={handleSeek}
            recordingReady={true}
            isLoading={transcriptLoading || legsLoading}
            onRetry={handleTranscriptRetry}
          />
        )}
      </div>

      <a
        href="#sync-workspace-player"
        className="sr-only focus:not-sr-only focus:mt-2 focus:inline-block focus:text-xs focus:text-[var(--c-accent)]"
      >
        Return to recording player
      </a>
    </SurfaceCard>
  );

  const deniedPane = (
    <SurfaceCard className="p-4 sm:p-5">
      <h2 className="mb-1 text-[15px] font-semibold tracking-tight text-[var(--c-ink)]">
        Transcript &amp; recording
      </h2>
      <p className="max-w-prose text-sm leading-relaxed text-[var(--c-ink-secondary)]">
        Detailed transcript playback and recording review require admin
        access. The session scorecard is shown alongside.
      </p>
    </SurfaceCard>
  );

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Session selector + context */}
      <SurfaceCard className="flex flex-col items-start gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        {/* `min-w-0` + a full-width select below `sm`: a native select sizes
            to its longest option, which at 390px ran past the card edge. */}
        <div className="flex w-full min-w-0 flex-wrap items-center gap-3 sm:w-auto">
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
            className="w-full min-w-0 max-w-full sm:w-auto"
          >
            {/* Named by WHEN and WHAT KIND, never by a uuid prefix: two
                sessions on one day are told apart by their time and length. */}
            {selectableSessions.map((s) => (
              <option key={s.id} value={s.id}>
                {/* M013 S02: a phone session reads its RECORDED total across
                    its calls, never `duration_sec` (which leaves out a
                    dropped call whose end was not observed). */}
                {[
                  formatDateTime(s.created_at),
                  sessionModeLabel(s.mode),
                  sessionLengthLabel(s),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </option>
            ))}
          </CandidateSelect>
        </div>
        {/* Only the status: date, kind and length are already the selected
            option's own words, one control to the left. */}
        {contextSession && (
          <StatusBadge tone={sessionStatusTone(contextSession.status)}>
            {sessionStatusLabel(contextSession.status)}
          </StatusBadge>
        )}
      </SurfaceCard>

      {frame(
        permissionDenied ? deniedPane : transcriptPane,
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
        />,
        scorecardAssessment,
      )}
    </div>
  );
}

/* ── Scorecard block ──────────────────────────────────────── */

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
  // v2 (role-scorecard) assessments render the metric-based card; everything
  // else renders the legacy 1–10 card unchanged.
  const v2 = assessment ? readScorecardAssessmentV2(assessment) : null;
  // A plain section, not a card: the scorecard's own sections are the first
  // card level and their sunken blocks the second, so wrapping the whole
  // thing in another card would make three — the nesting the owner flagged.
  return (
    <section aria-labelledby={headingId}>
      <h2
        id={headingId}
        className="mb-3 text-[15px] font-semibold tracking-tight text-[var(--c-ink)]"
      >
        {heading ?? 'Scorecard'}
      </h2>
      {/* C3: a scorecard held for thin interview evidence says so first. */}
      {!blocked && <EvidenceHoldNotice assessment={assessment} />}
      {blocked ? (
        <p className="max-w-prose text-sm leading-relaxed text-[var(--c-ink-secondary)]">
          Scorecards are suppressed while an appeal is under review.
        </p>
      ) : v2 ? (
        <CandidateScorecardV2 scorecard={v2} />
      ) : assessment ? (
        <CandidateScorecard assessment={assessment} narrative="none" roleFit="none" />
      ) : (
        <p className="max-w-prose text-sm leading-relaxed text-[var(--c-ink-secondary)]">
          No scorecard for this session yet. One is generated when a screening
          completes.
        </p>
      )}
    </section>
  );
}
