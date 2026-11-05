/**
 * TranscriptionSyncWorkspace — the ONE unified candidate review workspace.
 *
 * A single authoritative place to review a completed screening session, laid
 * out as a log sheet (Logsheet, M026):
 *   - the log header: one ruled row of role, screening, interviewer, length and
 *     where the candidate stands in Ashby
 *   - the call strip, drawn to scale, with its transport (ReviewTape)
 *   - two panes that scroll on their own at 1180px and up, and stack below it:
 *     the transcript as a log sheet (SeekableTranscript), and the reasoning
 *     (ReviewScorecard, or the older card for a legacy row and for R1)
 *
 * One clock and one cue. `reviewTimeline.ts` places every turn on a single
 * position along the session, and `cue` moves everything at once, instantly:
 * the playhead, the clock, the active turn, the pressed quote and the pane.
 * Pressing a moment also plays it (the signed URL is minted by that press, and
 * never on load). Review opens cued on the weakest metric's first quote, with
 * nothing playing and nothing minted.
 *
 * A cue outranks the audio until the audio catches up. Moving to another call
 * pauses the one playing, and that pause fires a last `timeupdate` from the old
 * position, so a report from any file but the cue's own is ignored until that
 * file reports, fails or something else is played (`cueWaitRef`).
 *
 * The phone players sit in the transcript pane, which opens scrolled to the cued
 * row, so the tape says what the recording is doing and offers its Try again
 * and Refresh link, and carries the consent tag of the call it stands on. The
 * R1 video sits outside both scrolling panes.
 *
 * Nothing plays on by itself. When a call's file runs out, "Play" moves to the
 * next call that can play, and after the last back to where playing starts,
 * which is never a clip from before consent while another can play.
 *
 * This replaces the previously duplicated recording/transcript/scorecard
 * presentations on the candidate page. All three artifacts come from a single
 * `GET /api/screening/:id` load, so they always correspond to the selected
 * session.
 *
 * Access: `GET /api/screening/:id` is admin-only. For non-admin reviewers the
 * transcript/recording load returns 403; we degrade gracefully — showing a
 * truthful note plus the candidate's latest screening scorecard, never an R1
 * one (from the viewer-visible candidate detail) instead of an error. With an
 * R1 session selected that scorecard is not this session's, so it is labelled
 * as the phone screening, the phone conflicts, role fit and summary (which have
 * no such label) wait for the phone session, and the note points at the R1 card
 * for the result, or at the candidate page from a host with no R1 card.
 *
 * Sync logic:
 *   1. Press a timed moment → if URL not loaded, mint it, queue the offset, wait
 *      for readiness, then seek + play (latest offset wins on rapid clicks).
 *   2. Playhead → the last turn in start-time order at or before it → highlight
 *      (`activeTurnAt`). A phone player reports on `timeupdate`; the R1 player
 *      every animation frame while playing. Either way this renders only when
 *      the active turn changes.
 *   3. R1 only: a click lands `R1_SEEK_LEAD_SEC` before the turn, where rule 2
 *      would light the row before it. So the clicked row lights at once and
 *      holds until the playhead reaches its start, then rule 2 is back. The
 *      hold ends sooner if the playhead leaves the lead-in (a scrub), playback
 *      ends, the media is dropped (the click then failed: no row stays lit) or
 *      the transcript changes. A click the player ignores lights nothing.
 *      While a seek is queued (`seekQueued`), held or not, the media's own
 *      reports do not count: a re-mint reloads it at 0, and the old file can run
 *      out first, so the lit row stays and is not announced again.
 *   4. Selecting a new session resets everything; stale loads are discarded.
 *
 * R1 sessions (a session that belongs to an R1 round): the recording is the R1
 * attempt's own, played by `R1RecordingPlayer` over the reasoning pane, where the
 * transcript following playback cannot move it, and the legacy `RecordingPlayer`
 * (and its download call, which R1 sessions have no file for) is never rendered.
 * The turns are placed on that recording from the attempt's
 * summary (`started_at_ms`, read from the rounds list) and a click seeks with
 * `playFromTurn`; a turn without a time stays untimed. A reduced API adapter
 * without the R1 rounds call degrades to a pointer, never an error.
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

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, ApiError } from '../../api';
import { readScorecardAssessmentV2, isAssessmentV2 } from '../../types';
import type {
  AshbyCandidateWorkflow,
  AshbyCandidateWorkflowOperation,
  Assessment,
  CandidatePhoneAttempt,
  CandidateResumeFacts,
  ResumeConflict,
  RoleFitScore,
  Session,
  TranscriptLine,
} from '../../types';
import { Combobox } from '../design/Combobox';
import type { ComboboxOption } from '../design/Combobox';
import { Skeleton, SkeletonText } from '../design/Skeleton';
import { CandidateButton, SurfaceCard } from '../design/candidate';
import { cx } from '../design/cx';
import {
  CandidateScorecard,
  CandidateScorecardNarrative,
  CandidateScorecardRoleFit,
} from './CandidateScorecard';
import { CandidateScorecardV2 } from './CandidateScorecardV2';
import { ashbyLifecycleLabel } from './AshbyWorkflowCard';
import { EvidenceHoldNotice } from './EvidenceHoldNotice';
import { R1RecordingPlayer } from '../r1/R1RecordingPlayer';
import type { R1RecordingPlayerHandle } from '../r1/R1RecordingPlayer';
import { RecordingPlayer } from './RecordingPlayer';
import type { RecordingPlayerHandle, RecordingPlayerStatus } from './RecordingPlayer';
import { FromTheResume, ReviewScorecard, metricDisplayName, weakestMetric } from './ReviewScorecard';
import { ReviewTape } from './ReviewTape';
import type { ReviewTapeHandle } from './ReviewTape';
import { SeekableTranscript } from './SeekableTranscript';
import type { ConsentFold, TranscriptReveal, TurnEvidence } from './SeekableTranscript';
import { SessionLegRow } from './SessionLegRow';
import {
  buildReviewRows,
  consentSummary,
  dropWords,
  legAxisStartSec,
  legGaps,
  legTalkLimits,
  timelineBaseMs,
  timelineEnds,
} from './reviewTimeline';
import type { SeekTarget } from './reviewTimeline';
import { stripAlternative, stripEndSec, stripSegments, stripTalk, timecode } from '../recording/callStripGeometry';
import {
  PHONE_HIGHLIGHT_TOLERANCE_SEC,
  activeTurnAt,
  activeTurnIn,
  clockLegIndex,
  groupTurnsByLeg,
  legConsentTag,
  legNoAudioLabel,
  legPlayable,
  legRecordingShown,
  legTitle,
  legUnseekableReason,
  reconnectedLegs,
  sessionLengthLabel,
  sortLegs,
} from './sessionLegs';
import type { LegGroup, LegSeekMode } from './sessionLegs';
import { formatDurationSec } from './status';
import { formatDateTime } from '../../lib/datetime';
import { isEvidenceInsufficient } from '../../lib/evidence-hold';
import { buildEvidence } from '../../lib/evidence-quotes';
import type { PlacedQuote } from '../../lib/evidence-quotes';
import { formatIstDateTime, formatIstTime, istDateOf } from '../../lib/ist-datetime';
import { latestScreeningAssessment } from '../../lib/latest-screening-assessment';
import { inSeekLead, turnMediaSec } from '../../lib/r1-recording';
import type { R1RecordingSummary } from '../../lib/r1-types';
import { sessionModeLabel } from '../../lib/session-mode';
import { AI_SPEAKER_LABEL, presentTranscriptTurn } from '../../lib/transcript-presentation';
import { readRoleScorecard } from '../session/scorecard-read';

/** What the Review tab calls an R1 session (it is not a phone screening). */
const R1_SESSION_LABEL = 'R1 role-play';

/** Where an R1 recording is when this host cannot play it or has no R1 card of its own. */
const R1_RECORDING_ON_CANDIDATE_PAGE =
  'The recording for this R1 session is on the candidate page, under R1 interview.';

/** The player's own words, unchanged: recording wording does not move without Legal. */
const RECORDING_NOTE = 'Recording loads on request; the link expires automatically.';

/** The session recording among the files the tape can be waiting on. A leg is its own id. */
const SESSION_FILE = 'session';
const NOTHING_ASKED: RecordingPlayerStatus = { phase: 'idle', message: null };

/** An R1 session's attempt summary, read from the candidate's rounds. */
type R1SessionRecording =
  | { sessionId: string; status: 'loading' }
  | { sessionId: string; status: 'ready'; roundId: string; summary: R1RecordingSummary }
  | { sessionId: string; status: 'unavailable' };

/** One leg page is plenty (a session has a handful of legs); follow a few. */
const LEG_PAGE_SIZE = 50;
const LEG_PAGES_MAX = 4;

type LegsState =
  | { sessionId: string; status: 'loading' }
  | { sessionId: string; status: 'ready'; legs: CandidatePhoneAttempt[] }
  | { sessionId: string; status: 'error' };

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
   * single session player. Its Overview tab has no R1 card either, so an R1
   * pointer names the candidate page instead.
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
  /**
   * False pauses an R1 recording: this tab can be hidden while its panel stays
   * mounted, and a video must not keep playing behind another tab. Default true.
   */
  active?: boolean;
  /** The candidate's name, for the transcript's speaker column. */
  candidateName?: string | null;
  /**
   * The role's title for the log header. null when the host looked and could not resolve it; left out
   * by a host that has no way to look (the scoped Ashby page), which drops the cell.
   */
  roleTitle?: string | null;
  /**
   * The candidate's Ashby workflow for the log header. null only when the read says there is no link;
   * undefined while it is not known, reading or failed, which must never read as "Not linked".
   */
  ashbyWorkflow?: AshbyCandidateWorkflow | null;
  /** The parsed resume, for "From the resume" under the rubric. */
  resumeFacts?: CandidateResumeFacts | null;
}

/** How the transcript names the candidate: their first name, or the plain word. */
function candidateFirstName(name: string | null | undefined): string {
  return name?.trim().split(/\s+/)[0] || 'Candidate';
}

/** The AI's red flags, or null when this row does not say. An absent list is not "none". */
function redFlagsOf(assessment: Assessment | null): string[] | null {
  const flags = assessment?.role_fit?.red_flags;
  return Array.isArray(flags) ? flags.filter((flag) => typeof flag === 'string' && flag.trim() !== '') : null;
}

/** Résumé conflicts, whether they arrive on the column or (rarely) inside raw. */
function resumeConflictsOf(a: Assessment): ResumeConflict[] {
  const raw = a.raw as { resume_conflicts?: ResumeConflict[] } | null | undefined;
  const list = a.resume_conflicts ?? raw?.resume_conflicts;
  return Array.isArray(list) ? list : [];
}

/**
 * "AI scorecard sent 11:58 IST", only over the session the write came from. A link holds one write, so
 * a re-screen or an older session on screen is not what reached Ashby, and a row held from Ashby never
 * reads as sent. It gives the date too when the write did not land on the session's own day.
 */
function scorecardSentNote(
  write: AshbyCandidateWorkflowOperation | undefined,
  sessionCreatedAt: string | null | undefined,
  held: boolean,
): string | null {
  if (!write || !sessionCreatedAt || held || write.state !== 'succeeded') return null;
  if (Date.parse(write.sessionCreatedAt ?? '') !== Date.parse(sessionCreatedAt)) return null;
  if (!write.updatedAt) return 'AI scorecard sent';
  const sameDay = istDateOf(write.updatedAt) === istDateOf(sessionCreatedAt);
  return `AI scorecard sent ${sameDay ? formatIstTime(write.updatedAt) : formatIstDateTime(write.updatedAt)}`;
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

export function TranscriptionSyncWorkspace({
  sessions,
  assessments,
  blocked,
  candidateId,
  callRecordings,
  active = true,
  candidateName = null,
  roleTitle,
  ashbyWorkflow,
  resumeFacts = null,
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
  // Which session the transcript state belongs to, once its read has answered.
  const [settledSessionId, setSettledSessionId] = useState<string | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [activeTurnIndex, setActiveTurnIndex] = useState<number | null>(null);
  // What the state holds, readable without a render: the R1 player reports every frame, and only a
  // change of turn may cost one.
  const activeTurnRef = useRef<number | null>(null);
  const showActiveTurn = useCallback((next: number | null) => {
    if (activeTurnRef.current === next) return;
    activeTurnRef.current = next;
    setActiveTurnIndex(next);
  }, []);
  // The start of the R1 row a click lit, while that row holds the highlight (file header, rule 3).
  const heldTurnStartRef = useRef<number | null>(null);
  const dropHeldTurn = useCallback(() => {
    if (heldTurnStartRef.current === null) return;
    heldTurnStartRef.current = null;
    showActiveTurn(null);
  }, [showActiveTurn]);

  // The evidence number that was cued. It stays pressed while its turn is the active one.
  const [activeEvidence, setActiveEvidence] = useState<number | null>(null);
  // True while the active row is only where Review opened: nothing is playing, so nothing is said.
  const [quietCue, setQuietCue] = useState(false);
  const [openMetrics, setOpenMetrics] = useState<ReadonlySet<string>>(() => new Set());
  const [consentOpen, setConsentOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  // Each new value brings the active row into view, whether or not the row changed.
  const [reveal, setReveal] = useState<TranscriptReveal>({ seq: 0, intoWindow: false });
  const bringRowIntoView = useCallback((intoWindow: boolean) => {
    setReveal((current) => ({ seq: current.seq + 1, intoWindow }));
  }, []);
  // Counts evidence presses: the one thing that moves the reasoning pane.
  const [quotePress, setQuotePress] = useState(0);
  // What each recording is doing, and the one the tape speaks for.
  const [fileStatus, setFileStatus] = useState<Readonly<Record<string, RecordingPlayerStatus>>>({});
  const [tapeFile, setTapeFile] = useState<string | null>(null);

  // refreshKey counter for retry — changing it re-triggers the effect
  const [refreshKey, setRefreshKey] = useState(0);

  const playerRef = useRef<RecordingPlayerHandle>(null);
  const r1PlayerRef = useRef<R1RecordingPlayerHandle>(null);
  const tapeRef = useRef<ReviewTapeHandle>(null);
  // Where "Play from" starts: the cued moment, or the playhead once it has moved. `named`: it can say so.
  const playFromRef = useRef<{ sec: number; target: SeekTarget | null; named: boolean }>({ sec: 0, target: null, named: false });
  // The file a cue is waiting to hear from: a leg id, null for the session recording, false for none
  // (the cued moment has no audio). See the file header.
  const cueWaitRef = useRef<{ file: string | null | false } | null>(null);
  const playingLegRef = useRef<string | null>(null);
  // What Review has already opened cued, so a re-render never cues it again. See `openKey`.
  const openedOnRef = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const transcriptPaneRef = useRef<HTMLDivElement | null>(null);
  const reasoningPaneRef = useRef<HTMLDivElement | null>(null);
  const transcriptHeadingId = useId();
  const sessionLabelId = useId();

  const selectedSession = useMemo(
    () => selectableSessions.find((s) => s.id === selectedSessionId) ?? null,
    [selectableSessions, selectedSessionId],
  );

  // An R1 session belongs to a round: its recording is that attempt's own (see the file header).
  const r1RoundId = selectedSession?.interview_round_id ?? null;
  const isR1 = r1RoundId !== null;

  // Load transcript + assessment + session meta when session/refreshKey changes
  const loadTranscript = useCallback((sessionId: string) => {
    let cancelled = false;
    setTranscriptLoading(true);
    setTranscriptError(null);
    setPermissionDenied(false);
    setTranscript([]);
    setSessionAssessment(null);
    setLoadedSession(null);
    showActiveTurn(null);
    setActiveEvidence(null);
    setQuietCue(false);
    setConsentOpen(false);
    setOpenMetrics(new Set());
    setPlaying(false);
    setTapeFile(null);
    playingLegRef.current = null;
    openedOnRef.current = null;
    playFromRef.current = { sec: 0, target: null, named: false };
    cueWaitRef.current = null;

    api
      .getSession(sessionId)
      .then((detail) => {
        if (cancelled) return;
        setTranscript(detail.transcript);
        setSessionAssessment(detail.assessment ?? null);
        setLoadedSession(detail.session ?? null);
        setSettledSessionId(sessionId);
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
  }, [showActiveTurn]);

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
      showActiveTurn(null);
      return;
    }
    return loadTranscript(selectedSessionId);
  }, [selectedSessionId, refreshKey, loadTranscript, showActiveTurn]);

  /* ── R1 recording: THIS session's attempt, from the rounds list ─── */

  const r1Supported = !!candidateId && typeof api.listR1Rounds === 'function';
  const [r1Rec, setR1Rec] = useState<R1SessionRecording | null>(null);
  const [r1RefreshKey, setR1RefreshKey] = useState(0);
  // Read only once the transcript has loaded: someone who cannot read the transcript (403) is
  // pointed at the Overview tab and costs the API nothing here.
  const loadedSessionId = loadedSession?.id ?? null;

  useEffect(() => {
    if (!isR1 || !r1Supported || !candidateId || !r1RoundId || !selectedSessionId || !loadedSessionId) {
      setR1Rec(null);
      return;
    }
    let cancelled = false;
    const sessionId = selectedSessionId;
    // A re-read ("Check again") keeps the player that is on screen until the answer is in.
    setR1Rec((prev) =>
      prev && prev.sessionId === sessionId && prev.status === 'ready' ? prev : { sessionId, status: 'loading' },
    );
    // `Promise.resolve().then`: an adapter without the call throws synchronously, which must not
    // unmount the transcript.
    Promise.resolve()
      .then(() => api.listR1Rounds(candidateId))
      .then((result) => {
        if (cancelled) return;
        const rounds = Array.isArray(result?.rounds) ? result.rounds : [];
        const round = rounds.find((r) => r.id === r1RoundId);
        const attempt =
          round && Array.isArray(round.attempts)
            ? round.attempts.find((a) => a?.session_id === sessionId)
            : undefined;
        setR1Rec(
          round && attempt?.recording
            ? { sessionId, status: 'ready', roundId: round.id, summary: attempt.recording }
            : { sessionId, status: 'unavailable' },
        );
      })
      .catch(() => {
        if (!cancelled) setR1Rec({ sessionId, status: 'unavailable' });
      });
    return () => {
      cancelled = true;
    };
  }, [isR1, r1Supported, candidateId, r1RoundId, selectedSessionId, loadedSessionId, r1RefreshKey]);

  const r1Ready = r1Rec?.sessionId === selectedSessionId && r1Rec.status === 'ready' ? r1Rec : null;
  const r1Summary = r1Ready?.summary ?? null;

  // The turns as the transcript shows them. A phone turn comes with its own offset; an R1 turn is
  // placed on the recording from the attempt's anchor (same worker clock, so exact), and a turn
  // without a time stays untimed rather than being given a wrong one.
  const displayTranscript = useMemo<TranscriptLine[]>(
    () =>
      !isR1
        ? transcript
        : transcript.map((turn) => ({
            ...turn,
            start_offset_sec: r1Summary ? turnMediaSec(turn.started_at_ms, r1Summary) : null,
          })),
    [isR1, transcript, r1Summary],
  );
  const turnStarts = useMemo(
    () => displayTranscript.map((turn) => turn.start_offset_sec),
    [displayTranscript],
  );

  // A hold belongs to the rows it was clicked on: another session or a reload ends it. In the commit, not
  // after it: a passive effect waits for the paint, so the first click on new rows can arrive before it,
  // and the rows that click landed on would then end its hold.
  useLayoutEffect(dropHeldTurn, [turnStarts, dropHeldTurn]);

  /* ── Phone legs (M013 S02) ─────────────────────────────────── */

  const legsEnabled =
    !!candidateId &&
    selectedSession?.mode === 'live' &&
    typeof api.getCandidatePhoneAttempts === 'function';
  const [legsState, setLegsState] = useState<LegsState | null>(null);
  const [legsRefreshKey, setLegsRefreshKey] = useState(0);
  const legPlayers = useRef(new Map<string, RecordingPlayerHandle>());

  useEffect(() => {
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
  // The call t = 0 stands on: the calls before it are listed and play, and have no place on the strip.
  const clockLeg = useMemo(() => clockLegIndex(legs), [legs]);
  const reconnects = useMemo(() => reconnectedLegs(legs), [legs]);
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

  const baseMs = useMemo(
    () => (isR1 ? null : timelineBaseMs(legs, loadedSession?.recording_egress_started_at_ms, transcript)),
    [isR1, legs, loadedSession, transcript],
  );

  /** The tag of the call a target plays, in the words the call's own row uses. */
  const consentTagOn = useCallback(
    (target: SeekTarget | null) => {
      const leg = target?.legId ? legs.find((candidate) => candidate.id === target.legId) : undefined;
      return leg && legRecordingShown(leg) ? (legConsentTag(leg.consent_stage)?.label ?? null) : null;
    },
    [legs],
  );

  /**
   * Move the playhead and the clock, and remember where "Play from" now stands. A moment on a call before
   * t = 0 has no place on the strip, so the tape stands at its start and "Play" names no moment there:
   * reading that call's file onto the strip would light a time in the interview that nothing was said at.
   */
  const moveTape = useCallback(
    (sec: number | null, target: SeekTarget | null) => {
      const beforeClock = legs.slice(0, clockLeg).some((leg) => leg.id === target?.legId);
      const placed = sec !== null && !beforeClock;
      const at = placed ? sec : target ? 0 : playFromRef.current.sec;
      const named = placed && target !== null;
      playFromRef.current = { sec: at, target, named };
      tapeRef.current?.setPosition(at, named, consentTagOn(target));
    },
    [legs, clockLeg, consentTagOn],
  );

  /** Where "Play" starts with nothing cued: a clip from before consent only if no other can play. */
  const playStart = useMemo(() => {
    const playable = legs.filter(legPlayable);
    const leg = playable.find((candidate) => candidate.consent_stage !== 'before_consent') ?? playable[0];
    if (!leg) return { sec: 0, target: { legId: null, offsetSec: 0 } };
    const sec = legAxisStartSec(leg, loadedSession?.recording_egress_started_at_ms, baseMs);
    return { sec, target: { legId: leg.id, offsetSec: 0 } };
  }, [legs, loadedSession, baseMs]);

  /** A file reported its position. True when that is left over from before a cue, and means nothing. */
  const reportIsStale = useCallback((file: string | null) => {
    const waiting = cueWaitRef.current;
    if (waiting === null) return false;
    if (waiting.file !== file) return true;
    cueWaitRef.current = null;
    return false;
  }, []);

  /** Something started playing. A cue waiting on a different file was overtaken by it. */
  const releaseCueFor = useCallback((file: string | null) => {
    if (cueWaitRef.current?.file !== file) cueWaitRef.current = null;
  }, []);

  /** A recording's state, from its player. A file that failed will never answer the cue. */
  const reportFile = useCallback((file: string, status: RecordingPlayerStatus) => {
    setFileStatus((known) => {
      const was = known[file];
      return was?.phase === status.phase && was.message === status.message ? known : { ...known, [file]: status };
    });
    if (status.message !== null && (cueWaitRef.current?.file ?? SESSION_FILE) === file) cueWaitRef.current = null;
  }, []);

  const handleSessionPlayState = useCallback(
    (sessionPlaying: boolean) => {
      setPlaying(sessionPlaying);
      if (!sessionPlaying) return;
      releaseCueFor(null);
      setTapeFile(SESSION_FILE);
    },
    [releaseCueFor],
  );

  const handleTimeUpdate = useCallback(
    (currentTime: number) => {
      if (reportIsStale(null)) return;
      setQuietCue(false);
      if (legsMode) {
        // Session seek mode: every group carries session offsets, so the
        // playing turn is the last one (in reading order) at or before t.
        let found: number | null = null;
        for (const g of legGroups) {
          const index = activeTurnIn(g.turns, currentTime);
          if (index !== null) found = g.turns[index].index;
        }
        showActiveTurn(found);
        moveTape(currentTime, { legId: null, offsetSec: currentTime });
        return;
      }
      // A queued seek has not moved the media yet, so this position says nothing about where it will be.
      if (r1PlayerRef.current?.seekQueued) return;
      const heldStart = heldTurnStartRef.current;
      if (heldStart !== null) {
        if (inSeekLead(heldStart, currentTime)) return;
        heldTurnStartRef.current = null;
      }
      // R1 lights a row at its start; a phone row keeps its early tolerance.
      showActiveTurn(activeTurnAt(turnStarts, currentTime, isR1 ? 0 : PHONE_HIGHLIGHT_TOLERANCE_SEC));
      moveTape(currentTime, { legId: null, offsetSec: currentTime });
    },
    [isR1, turnStarts, legsMode, legGroups, showActiveTurn, moveTape, reportIsStale],
  );

  const handleR1Ended = useCallback(
    (sec: number) => {
      // The old file ran out while its link was being replaced: the seek is still on its way.
      if (r1PlayerRef.current?.seekQueued) return;
      heldTurnStartRef.current = null;
      handleTimeUpdate(sec);
    },
    [handleTimeUpdate],
  );

  // An R1 click seeks with the player's own lead-in and holds its row through it. A phone press is `cue`.
  const handleSeek = useCallback(
    (offsetSec: number, rowIndex: number) => {
      // Seek by the clicked turn's OWN start time, so the lead-in and the anchor are applied in one place.
      const startedAtMs = displayTranscript[rowIndex]?.started_at_ms;
      if (typeof startedAtMs !== 'number' || !r1PlayerRef.current?.playFromTurn(startedAtMs)) return;
      heldTurnStartRef.current = offsetSec;
      showActiveTurn(rowIndex);
    },
    [displayTranscript, showActiveTurn],
  );

  /** A leg's playhead moved: highlight within that leg's group only, and read it onto the clock. */
  const handleLegTimeUpdate = useCallback(
    (legIndex: number, currentTime: number) => {
      const leg = legs[legIndex];
      if (leg && reportIsStale(leg.id)) return;
      setQuietCue(false);
      const group = legGroups.find((g) => g.legIndex === legIndex);
      const index = group ? activeTurnIn(group.turns, currentTime) : null;
      showActiveTurn(group && index !== null ? group.turns[index].index : null);
      if (!leg) return;
      const startSec = legAxisStartSec(leg, loadedSession?.recording_egress_started_at_ms, baseMs);
      moveTape(startSec + currentTime, { legId: leg.id, offsetSec: currentTime });
    },
    [legGroups, legs, loadedSession, baseMs, showActiveTurn, moveTape, reportIsStale],
  );

  /** One leg plays at a time: starting one pauses the others. */
  const handleLegPlayState = useCallback(
    (legId: string, legPlaying: boolean) => {
      if (!legPlaying) {
        if (playingLegRef.current !== legId) return;
        playingLegRef.current = null;
        setPlaying(false);
        return;
      }
      releaseCueFor(legId);
      playingLegRef.current = legId;
      setPlaying(true);
      setTapeFile(legId);
      legPlayers.current.forEach((player, id) => {
        if (id !== legId) player.pause();
      });
    },
    [releaseCueFor],
  );

  /**
   * A file ran out. A cue still on its way outranks this (see the file header). The lit row stays: a
   * press on a file's last moment ends it at once, and must not unlight the moment that was pressed.
   */
  const handleFileEnded = useCallback(
    (legId: string | null) => {
      if (cueWaitRef.current !== null) return;
      const after = legs.findIndex((leg) => leg.id === legId);
      const next = after < 0 ? undefined : legs.slice(after + 1).find(legPlayable);
      if (next) {
        const startSec = legAxisStartSec(next, loadedSession?.recording_egress_started_at_ms, baseMs);
        moveTape(startSec, { legId: next.id, offsetSec: 0 });
      } else {
        moveTape(playStart.sec, playStart.target);
      }
    },
    [legs, loadedSession, baseMs, playStart, moveTape],
  );

  const handleTranscriptRetry = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const handleSessionChange = useCallback((id: string) => {
    setSelectedSessionId(id || null);
  }, []);

  /* ── The one clock, the evidence and the cue ────────────────────── */

  const rows = useMemo(
    () => buildReviewRows({ transcript: displayTranscript, legs, groups: legGroups, seekMode, baseMs }),
    [displayTranscript, legs, legGroups, seekMode, baseMs],
  );

  // The scorecard shown is the selected session's own assessment when
  // available; for non-admins it falls back to the candidate's latest SCREENING
  // (the header's rule): "Latest scorecard" is never an R1 role-play result.
  // When the read failed the candidate payload still has the session's own row,
  // so a transcript that would not load does not take the scorecard with it.
  const latestScreening = latestScreeningAssessment(assessments, sessions);
  const ownAssessment = useMemo(
    () => assessments.find((a) => a.session_id != null && a.session_id === selectedSessionId) ?? null,
    [assessments, selectedSessionId],
  );
  const scorecardAssessment =
    sessionAssessment ?? (permissionDenied ? latestScreening : transcriptError ? ownAssessment : null);
  // The fallback row can be another call's, and must then never read as this one's.
  const otherCallScorecard =
    sessionAssessment === null && scorecardAssessment !== null && scorecardAssessment.session_id !== selectedSessionId;

  const reviewCard = useMemo(() => {
    if (blocked || isR1 || !scorecardAssessment) return null;
    const card = readRoleScorecard(scorecardAssessment);
    if (!card) return null;
    return { ...card, metrics: card.metrics.map((m, i) => ({ ...m, name: metricDisplayName(m, i) })) };
  }, [blocked, isR1, scorecardAssessment]);

  // A quote is placed only on the session it scored: a fallback row is another call's words.
  const placesQuotes = sessionAssessment !== null;
  const evidence = useMemo(
    () =>
      buildEvidence(
        reviewCard?.metrics ?? [],
        placesQuotes
          ? rows.map((r) => ({
              row: r.row,
              speaker: r.turn.speaker,
              text: r.turn.text,
              isGate: r.turn.is_gate === true,
              // Only for the order of the numbers: a call before t = 0 came first, with no time to give.
              atSec: r.legIndex !== null && r.legIndex < clockLeg ? 0 : r.atSec,
            }))
          : [],
      ),
    [reviewCard, placesQuotes, rows, clockLeg],
  );
  const quoteNamed = useCallback(
    (number: number) => evidence.placed.find((quote) => quote.number === number) ?? null,
    [evidence],
  );

  /** A placed quote's moment, printed the way its row prints it. */
  const momentOf = useCallback(
    (quote: PlacedQuote) => {
      const row = rows[quote.row];
      const approx = row?.approximate ? '≈' : '';
      return {
        turn: quote.row + 1,
        clock: row?.atSec == null ? null : `${approx}${timecode(row.atSec)}`,
        playable: row?.target != null,
      };
    },
    [rows],
  );

  /** Play a moment on the file it lives in. One call plays at a time. */
  const playTarget = useCallback((target: SeekTarget) => {
    setTapeFile(target.legId ?? SESSION_FILE);
    if (target.legId === null) {
      playerRef.current?.playFrom(target.offsetSec);
      return;
    }
    legPlayers.current.forEach((player, id) => {
      if (id !== target.legId) player.pause();
    });
    legPlayers.current.get(target.legId)?.playFrom(target.offsetSec);
  }, []);

  const handlePause = useCallback(() => {
    playerRef.current?.pause();
    legPlayers.current.forEach((player) => player.pause());
  }, []);

  /**
   * THE one way a moment is cued, for a tick, a quote button, a margin number or a timecode. Everything
   * the screen can show moves here, in this commit, before any audio answers: the playhead, the clock,
   * the active turn, the pressed quote and the pane. The recording is minted by this press if it has
   * to be. A row with nowhere to play still cues, and stops what was playing, which would otherwise
   * carry the screen straight back.
   */
  const cue = useCallback(
    (rowIndex: number, evidenceNumber: number | null) => {
      const row = rows[rowIndex];
      if (!row) return;
      setQuietCue(false);
      setActiveEvidence(evidenceNumber);
      showActiveTurn(rowIndex);
      moveTape(row.atSec, row.target);
      bringRowIntoView(true);
      cueWaitRef.current = { file: row.target ? row.target.legId : false };
      if (row.target) playTarget(row.target);
      else handlePause();
    },
    [rows, showActiveTurn, moveTape, bringRowIntoView, playTarget, handlePause],
  );

  const cueEvidence = useCallback(
    (number: number) => {
      const quote = quoteNamed(number);
      if (!quote) return;
      setOpenMetrics((open) => (open.has(quote.metricId) ? open : new Set(open).add(quote.metricId)));
      setQuotePress((count) => count + 1);
      cue(quote.row, number);
    },
    [quoteNamed, cue],
  );

  // Bring a pressed quote into the reasoning pane, without moving keyboard focus. Only for a press: Review
  // opens with this pane at its top on the recommendation, and playing leaves it where the reader left it.
  useLayoutEffect(() => {
    if (quotePress === 0 || activeEvidence === null) return;
    const pane = reasoningPaneRef.current;
    const quote = pane?.querySelector<HTMLElement>(`[data-quote-button="${activeEvidence}"]`);
    if (!pane || !quote) return;
    const paneBox = pane.getBoundingClientRect();
    const quoteBox = quote.getBoundingClientRect();
    if (quoteBox.top >= paneBox.top && quoteBox.bottom <= paneBox.bottom) return;
    pane.scrollTop += quoteBox.top - paneBox.top - 16;
    // Keyed on the press alone: what it reads changes for other reasons, and those must not scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quotePress]);

  const handleToggleMetric = useCallback((metricId: string) => {
    setOpenMetrics((open) => {
      const next = new Set(open);
      if (!next.delete(metricId)) next.add(metricId);
      return next;
    });
  }, []);

  // Review opens cued on the weakest metric's first quote, as the sheet was left: nothing plays and
  // nothing is minted. In the commit, so the first paint is already there, and only once per session.
  // The calls arriving late (a Retry) open it again: the rows come back on another clock, and any target
  // left on the session recording would point at a player that has gone.
  const detailReady = settledSessionId === selectedSessionId && !transcriptLoading && !legsLoading;
  const openKey = `${selectedSessionId}:${legsMode}`;
  useLayoutEffect(() => {
    if (!detailReady || openedOnRef.current === openKey) return;
    openedOnRef.current = openKey;
    cueWaitRef.current = null;
    const weakest = reviewCard ? weakestMetric(reviewCard.metrics) : null;
    const first = weakest ? evidence.placed.find((quote) => quote.metricId === weakest.id) : null;
    const row = first ? rows[first.row] : null;
    if (!first || !row) {
      setActiveEvidence(null);
      showActiveTurn(null);
      moveTape(0, null);
      return;
    }
    setQuietCue(true);
    setActiveEvidence(first.number);
    showActiveTurn(first.row);
    moveTape(row.atSec, row.target);
    bringRowIntoView(false);
  }, [detailReady, openKey, reviewCard, evidence, rows, showActiveTurn, moveTape, bringRowIntoView]);

  // The strip. Only a phone session has one, and only when its turns have times.
  const speakers = useMemo(() => ({ bot: AI_SPEAKER_LABEL, candidate: candidateFirstName(candidateName) }), [candidateName]);
  // A line that was cut off is a turn the estimate overshoots, so each stops where its call stopped.
  const talkLimits = useMemo(
    () => legTalkLimits(legs, loadedSession?.recording_egress_started_at_ms, baseMs),
    [legs, loadedSession, baseMs],
  );
  const segments = useMemo(
    () =>
      stripSegments(
        rows.flatMap((r) =>
          r.atSec === null
            ? []
            : [
                {
                  speaker: r.turn.speaker === 'bot' ? ('ai' as const) : ('candidate' as const),
                  startSec: r.atSec,
                  text: presentTranscriptTurn(r.turn.speaker, r.turn.text).text,
                  gate: r.turn.is_gate === true,
                  limitSec: r.legIndex === null ? null : talkLimits[r.legIndex],
                },
              ],
        ),
      ),
    [rows, talkLimits],
  );
  const gaps = useMemo(() => legGaps(legs, baseMs), [legs, baseMs]);
  const drops = useMemo(() => gaps.filter((gap) => gap.dropped), [gaps]);
  const plainGaps = useMemo(() => gaps.filter((gap) => !gap.dropped), [gaps]);
  const endSec = useMemo(
    () =>
      stripEndSec(
        segments,
        legsMode ? timelineEnds(legs, loadedSession?.recording_egress_started_at_ms, baseMs) : [],
      ),
    [segments, legsMode, legs, loadedSession, baseMs],
  );
  const consent = useMemo(() => (isR1 ? null : consentSummary(rows, legs)), [isR1, rows, legs]);
  const consentAt = consent ? `${consent.approximate ? '≈' : ''}${timecode(consent.atSec)}` : null;
  const ticks = useMemo(
    () =>
      evidence.placed.flatMap((quote) => {
        const at = rows[quote.row]?.atSec;
        if (at == null) return [];
        return [{
          number: quote.number,
          sec: at,
          label: `Evidence ${quote.number}: turn ${quote.row + 1} at ${timecode(at)}, ${quote.metricName}`,
        }];
      }),
    [evidence, rows],
  );

  // Turns folded into the consent line, and how a row of a list finds its quotes.
  const evidenceIn = useCallback(
    (toListIndex: (row: number) => number) => {
      const byRow = new Map<number, TurnEvidence[]>();
      for (const quote of evidence.placed) {
        const index = toListIndex(quote.row);
        if (index < 0) continue;
        byRow.set(index, [
          ...(byRow.get(index) ?? []),
          { number: quote.number, metricName: quote.metricName, start: quote.start, end: quote.end },
        ]);
      }
      return byRow;
    },
    [evidence],
  );

  const foldIn = (toListIndex: (row: number) => number): ConsentFold | null => {
    if (!consent || !consentAt || consentOpen) return null;
    const firstIndex = toListIndex(consent.firstRow);
    const lastIndex = toListIndex(consent.lastRow);
    if (firstIndex < 0 || lastIndex < 0) return null;
    const first = consent.firstRow + 1;
    const last = consent.lastRow + 1;
    return {
      firstIndex,
      lastIndex,
      line: `Consent given at ${consentAt}`,
      showLabel: `Show ${consent.count} ${consent.count === 1 ? 'turn' : 'turns'}`,
      atSec: rows[consent.firstRow]?.atSec ?? null,
      approximate: consent.approximate,
      turnsLabel: first === last ? `T${first}` : `T${first}–${last}`,
      onShow: () => setConsentOpen(true),
    };
  };

  // Opening the consent line takes the button that was pressed with it, so focus goes to the first turn:
  // its timecode, or on a call with no audio, which has none, the row itself.
  useLayoutEffect(() => {
    if (!consentOpen || !consent) return;
    const row = transcriptPaneRef.current?.querySelector<HTMLElement>(`[data-turn-row="${consent.firstRow + 1}"]`);
    (row?.querySelector<HTMLElement>('button') ?? row)?.focus({ preventScroll: true });
    // Only on the transition to open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consentOpen]);

  // The quote stays pressed while its turn is the active one.
  const pressedEvidence =
    activeEvidence !== null && quoteNamed(activeEvidence)?.row === activeTurnIndex ? activeEvidence : null;

  const talk = useMemo(() => stripTalk(segments), [segments]);
  const dropForLeg = useMemo(() => new Map(drops.map((drop) => [drop.legIndex, drop])), [drops]);

  // Worker-era calls keep their audio per call, so with none playable and no session anchor there is no
  // file to ask for. A simulation never has one.
  const hasSessionFile =
    selectedSession?.mode !== 'simulation'
    && (!legsMode || loadedSession?.recording_egress_started_at_ms != null);
  const canPlay = seekMode === 'leg' || hasSessionFile;

  const handlePlay = useCallback(() => {
    setQuietCue(false);
    const from = playFromRef.current.target;
    if (!from) moveTape(playStart.sec, playStart.target);
    playTarget(from ?? playStart.target);
  }, [playStart, moveTape, playTarget]);

  const fileNamed = useCallback(
    (file: string | null) => (file === SESSION_FILE ? playerRef.current : file ? legPlayers.current.get(file) : null),
    [],
  );
  const handleTapeRetry = useCallback(() => void fileNamed(tapeFile)?.load(), [fileNamed, tapeFile]);
  const handleTapeRefresh = useCallback(() => fileNamed(tapeFile)?.refresh(), [fileNamed, tapeFile]);

  // At 1180px and up the page does not scroll and the panes do, so the workspace is as tall as what is
  // left of the window. What is left depends on the header above it, which wraps with the candidate's
  // facts, so it is measured. A hidden tab measures nothing, and is measured again when it shows. Nothing
  // scrolls while hidden either, so a cue made then (the scoped page always opens on Overview, and Review
  // cues there unseen) reaches the transcript only when the tab shows.
  const rootShownRef = useRef(false);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const top = root.getBoundingClientRect().top + window.scrollY;
      root.style.setProperty('--review-top', `${Math.round(top)}px`);
      const shown = root.getClientRects().length > 0;
      if (shown && !rootShownRef.current) bringRowIntoView(false);
      rootShownRef.current = shown;
    };
    measure();
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(root);
    const sheet = root.closest('main');
    if (sheet) observer?.observe(sheet);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
    // `active`: the header above changes height with the tab.
  }, [selectableSessions.length, active, bringRowIntoView]);

  const turnCount = transcript.length;

  if (selectableSessions.length === 0) {
    return (
      <div className="space-y-4 sm:space-y-6">
        <div className="grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-12 lg:items-start">
          <div className="min-w-0 space-y-4 sm:space-y-6 lg:col-span-7">
            <SurfaceCard className="p-4 sm:p-5">
              <h2 className="mb-1 text-section text-[var(--c-ink)]">
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
            {!blocked && latestScreening && resumeConflictsOf(latestScreening).length > 0 && (
              <CandidateScorecardNarrative assessment={latestScreening} parts="conflicts" headingLevel={2} />
            )}
          </div>
          <div className="min-w-0 lg:col-span-5">
            <ScorecardBlock
              blocked={blocked}
              assessment={latestScreening}
              heading={latestScreening ? 'Latest scorecard' : undefined}
            />
          </div>
        </div>
        <ScorecardNarrative assessment={blocked ? null : latestScreening} conflicts={false} />
      </div>
    );
  }

  const options: ComboboxOption[] = selectableSessions.map((s) => ({
    // Named by WHEN and WHAT KIND, never by a uuid prefix: two sessions on one
    // day are told apart by their time and length. The value is an opaque key.
    value: s.id,
    label: [formatDateTime(s.created_at), s.interview_round_id != null ? R1_SESSION_LABEL : sessionModeLabel(s.mode)]
      .filter(Boolean)
      .join(' · '),
    // M013 S02: a phone session reads its RECORDED total across its calls,
    // never `duration_sec` (which leaves out a dropped call whose end was not observed).
    description: sessionLengthLabel(s) ?? undefined,
  }));

  /* The strip and its transport. Always the same height, loading or not. */
  const tapeShown = !isR1 && !permissionDenied && !transcriptError && detailReady && segments.length > 0;

  const dropCount = drops.length;
  // The list row, never the loaded one: the recorded roll-ups are computed for the candidate read, and
  // GET /api/screening/:id sends the bare call_sessions row, which has none. The scoped Ashby read sends
  // bare rows too, so there the strip's own length stands in, marked as an estimate.
  const lengthWords = selectedSession ? sessionLengthLabel(selectedSession) : null;
  const lengthShown = lengthWords ?? (tapeShown ? `≈${formatDurationSec(endSec)}` : 'Not known');
  const dropNote =
    dropCount === 0 ? null : `line dropped ${dropCount === 1 ? 'once' : dropCount === 2 ? 'twice' : `${dropCount} times`}`;

  const scorecardSent = scorecardSentNote(
    ashbyWorkflow?.operations.find((op) => op.type === 'scorecard_write'),
    selectedSession?.created_at,
    isEvidenceInsufficient(scorecardAssessment),
  );

  /* The log header: one ruled row of labelled cells. */
  const logHeader = (
    <dl
      data-log-header=""
      className={cx(
        'grid grid-cols-1 border-y border-rule-2 sm:grid-cols-2',
        roleTitle === undefined
          ? 'min-[1180px]:grid-cols-[1.5fr_0.8fr_1.2fr_1.25fr]'
          : 'min-[1180px]:grid-cols-[1.05fr_1.5fr_0.8fr_1.2fr_1.25fr]',
      )}
    >
      {roleTitle !== undefined && <LogCell label="Role">{roleTitle ?? 'Not available'}</LogCell>}
      <LogCell label="Screening" labelId={sessionLabelId}>
        {/* One session has nothing to choose between, so it is a line of text. Two or more are a
            picker: never the operating system's list, which is the control the owner screenshotted.
            It floats, or opening it would push the tape and both panes down the page. */}
        {options.length === 1 ? (
          <span data-session-text="">{options[0].label}</span>
        ) : (
          <Combobox
            id="sync-session-select"
            labelId={sessionLabelId}
            size="sm"
            floating
            searchable={options.length > 6}
            value={selectedSessionId ?? ''}
            onChange={handleSessionChange}
            options={options}
            placeholder="Choose a session"
            searchLabel="Search sessions"
            listLabel="Sessions"
            noun={['session', 'sessions']}
          />
        )}
      </LogCell>
      <LogCell label="Interviewer">{isR1 ? R1_SESSION_LABEL : AI_SPEAKER_LABEL}</LogCell>
      <LogCell label="Length">
        {lengthShown}
        {dropNote && <span className="text-ink-tertiary"> · {dropNote}</span>}
      </LogCell>
      <LogCell label="In Ashby">
        {ashbyWorkflow ? (
          <>
            {ashbyLifecycleLabel(ashbyWorkflow.lifecycle)}
            {scorecardSent && <span className="text-ink-tertiary"> · {scorecardSent}</span>}
          </>
        ) : ashbyWorkflow === null ? (
          'Not linked'
        ) : (
          'Not available'
        )}
      </LogCell>
    </dl>
  );

  // A cued moment with no audio says why, in the words its call's group already uses.
  const cuedRow = activeTurnIndex === null ? null : (rows[activeTurnIndex] ?? null);
  const silentLeg = cuedRow && cuedRow.target === null && cuedRow.legIndex !== null ? legs[cuedRow.legIndex] : null;
  const tape =
    isR1 || permissionDenied || transcriptError ? null : tapeShown ? (
      <ReviewTape
        key={selectedSessionId}
        ref={tapeRef}
        startSec={playFromRef.current.sec}
        startPlayable={playFromRef.current.named}
        startConsentTag={consentTagOn(playFromRef.current.target)}
        canPlay={canPlay}
        playing={playing}
        onPlay={handlePlay}
        onPause={handlePause}
        recording={tapeFile === null ? NOTHING_ASKED : (fileStatus[tapeFile] ?? NOTHING_ASKED)}
        onRetry={handleTapeRetry}
        onRefresh={handleTapeRefresh}
        segments={segments}
        endSec={endSec}
        drops={drops}
        gaps={plainGaps}
        ticks={ticks}
        notes={drops.map((drop) => ({ sec: drop.fromSec ?? drop.toSec, text: 'Line dropped' }))}
        activeTick={pressedEvidence}
        onTick={cueEvidence}
        alternative={stripAlternative({
          endSec,
          calls: Math.max(1, legs.slice(clockLeg).filter((leg) => leg.connected_from ?? leg.answered_at).length),
          candidateName: speakers.candidate,
          talk,
          consentAt,
          drops,
          gaps: plainGaps,
          quotes: ticks.length,
        })}
        candidateName={speakers.candidate}
        candidateTalk={talk.candidateShare === null ? null : `≈${timecode(talk.candidateSec)} · ≈${talk.candidateShare}% of talk`}
        aiName={speakers.bot}
        aiTalk={talk.aiSec > 0 ? `≈${timecode(talk.aiSec)}` : null}
        note={
          !canPlay
            ? legNoAudioLabel(legs[0]?.recording.reason)
            : silentLeg
              ? legUnseekableReason(silentLeg)
              : RECORDING_NOTE
        }
      />
    ) : !detailReady ? (
      <TapePlaceholder />
    ) : null;

  const players = (
    <div id="sync-workspace-player" className="border-b border-rule px-6 py-3 empty:hidden">
      {selectedSessionId && legsLoading && (
        <p className="text-label text-[var(--c-ink-secondary)]">Loading the calls in this session…</p>
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
              reconnect={reconnects.has(i)}
              sessionId={selectedSessionId}
              onTimeUpdate={(t) => handleLegTimeUpdate(i, t)}
              onPlayState={(state) => handleLegPlayState(leg.id, state)}
              onEnded={() => handleFileEnded(leg.id)}
              onStatus={(status) => reportFile(leg.id, status)}
              tapeDriven={tapeShown}
            />
          ))}
        </ol>
      )}
      {selectedSessionId && legsFailed && (
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1" role="alert">
          <p className="text-label text-[var(--c-ink-secondary)]">
            The calls in this session could not be listed. The session recording is below.
          </p>
          <button
            type="button"
            onClick={() => setLegsRefreshKey((k) => k + 1)}
            className="textlink text-xs font-medium text-[var(--c-accent)]"
          >
            Retry
          </button>
        </div>
      )}
      {selectedSessionId && showSessionPlayer && !isR1 && (
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
            onPlayState={handleSessionPlayState}
            onEnded={() => handleFileEnded(null)}
            onStatus={(status) => reportFile(SESSION_FILE, status)}
            tapeDriven={tapeShown}
          />
        </div>
      )}
    </div>
  );

  /* An R1 session: the attempt's own recording. Above the panes it would take the transcript's height,
     and inside the transcript's pane following the playback would scroll the video and its controls
     away, so it heads the reasoning column and stays put. The legacy player (and its download call) is
     never rendered for it. */
  const r1PlayerSlot =
    selectedSessionId && isR1 && !permissionDenied && !transcriptError ? (
      <div
        data-r1-player-slot=""
        className="min-w-0 border-b border-rule px-6 py-3 min-[1180px]:col-start-2 min-[1180px]:row-start-1 min-[1180px]:border-l min-[1180px]:border-l-rule-2 min-[1180px]:pl-5"
      >
        <h3 className="sr-only">{R1_SESSION_LABEL} recording</h3>
        {r1Ready ? (
          <R1RecordingPlayer
            key={selectedSessionId}
            ref={r1PlayerRef}
            roundId={r1Ready.roundId}
            sessionId={selectedSessionId}
            summary={r1Ready.summary}
            label={R1_SESSION_LABEL}
            active={active}
            onTimeUpdate={handleTimeUpdate}
            onEnded={handleR1Ended}
            onMediaDropped={dropHeldTurn}
            onNeedRefresh={() => setR1RefreshKey((k) => k + 1)}
          />
        ) : r1Supported && r1Rec?.status !== 'unavailable' ? (
          <p role="status" className="text-label text-[var(--c-ink-secondary)]">
            Loading recording details…
          </p>
        ) : (
          <p className="text-label text-[var(--c-ink-secondary)]">
            {R1_RECORDING_ON_CANDIDATE_PAGE}
          </p>
        )}
      </div>
    ) : null;

  const flatEvidence = evidenceIn((row) => row);

  const transcriptRows =
    legsMode && !transcriptLoading && legGroups.length > 0 ? (
      /* Turns grouped by the call they were spoken in. */
      legGroups.map((group) => {
        const key = groupKey(group);
        const leg = group.legIndex === null ? null : legs[group.legIndex];
        const headingId = `${transcriptHeadingId}-leg-${key}`;
        const indexOf = (row: number) => group.turns.findIndex((t) => t.index === row);
        const drop = group.legIndex === null ? undefined : dropForLeg.get(group.legIndex);
        const activeHere = activeTurnIndex === null ? -1 : indexOf(activeTurnIndex);
        return (
          <div key={key} role="group" aria-labelledby={headingId}>
            <div className="border-b border-rule bg-field px-6 py-1.5">
              <h3 id={headingId} className="text-meta font-semibold text-ink-secondary">
                {leg && group.legIndex !== null
                  ? legTitle(group.legIndex, legs.length, reconnects.has(group.legIndex))
                  : 'Turns without timing'}
              </h3>
              {drop && <p className="text-meta text-ink-secondary">{dropWords(drop)}</p>}
              {group.approximate && (
                <p className="text-meta text-ink-secondary">
                  Times in this call (≈) are estimated from when it was answered.
                </p>
              )}
              {group.unseekableReason && <p className="text-meta text-ink-secondary">{group.unseekableReason}</p>}
            </div>
            <SeekableTranscript
              transcript={group.turns.map((t) => t.turn)}
              turnNumbers={group.turns.map((t) => t.index + 1)}
              activeTurnIndex={activeHere < 0 ? null : activeHere}
              onSeek={(_offset, index) => cue(group.turns[index].index, null)}
              recordingReady={true}
              approximateTiming={group.approximate}
              turnTimes={group.turns.map((t) => ({ sec: t.callSec, atMs: t.atMs }))}
              unseekableReason={group.unseekableReason}
              speakers={speakers}
              clock={group.turns.map((t) => rows[t.index]?.atSec)}
              evidence={evidenceIn(indexOf)}
              activeEvidence={pressedEvidence}
              onEvidence={cueEvidence}
              consent={foldIn(indexOf)}
              announce={!quietCue}
              reveal={reveal}
            />
          </div>
        );
      })
    ) : (
      <SeekableTranscript
        transcript={displayTranscript}
        activeTurnIndex={activeTurnIndex}
        onSeek={isR1 ? handleSeek : (_offset, index) => cue(index, null)}
        recordingReady={true}
        isLoading={transcriptLoading || legsLoading}
        onRetry={handleTranscriptRetry}
        speakers={isR1 ? undefined : speakers}
        clock={isR1 ? undefined : rows.map((row) => row.atSec)}
        approximateTiming={rows.some((row) => row.approximate)}
        evidence={flatEvidence}
        activeEvidence={pressedEvidence}
        onEvidence={cueEvidence}
        consent={foldIn((row) => row)}
        announce={!quietCue}
        reveal={reveal}
      />
    );

  const transcriptPane = transcriptError ? (
    <div className="px-6 py-5" role="alert">
      <h2 className="text-section text-ink">Transcript</h2>
      <p className="mt-1 text-sm text-ink-secondary">The transcript could not be loaded.</p>
      <CandidateButton variant="secondary" size="md" className="mt-3" onClick={handleTranscriptRetry}>
        Retry
      </CandidateButton>
    </div>
  ) : permissionDenied ? (
    <div className="px-6 py-5">
      <h2 className="mb-1 text-section text-[var(--c-ink)]">
        Transcript &amp; recording
      </h2>
      <p className="max-w-prose text-sm leading-relaxed text-[var(--c-ink-secondary)]">
        Detailed transcript playback and recording review require admin
        access.
        {isR1
          ? null
          : otherCallScorecard && !blocked
            ? ' The latest scorecard is shown alongside.'
            : ' The session scorecard is shown alongside.'}
      </p>
      {isR1 && (
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-[var(--c-ink-secondary)]">
          {/* Nothing alongside is this role-play's. A host without a candidate id (the scoped Ashby
              page) has no R1 card on its Overview tab. While an appeal blocks decision use the result
              is withheld on the R1 card too, so only the recording is pointed at. */}
          {!candidateId
            ? R1_RECORDING_ON_CANDIDATE_PAGE
            : blocked
              ? 'This role-play’s recording is on the Overview tab, under R1 interview.'
              : 'This role-play’s result and recording are on the Overview tab, under R1 interview.'}
        </p>
      )}
    </div>
  ) : (
    <>
      {/* The sticky head stays over the rows as the pane scrolls. */}
      <div className="sticky top-0 z-10 flex items-baseline gap-3 border-b border-rule-2 bg-paper px-6 py-2.5">
        <h2 id={transcriptHeadingId} className="text-section text-[var(--c-ink)]">
          Transcript
        </h2>
        <span className="text-meta tabular-nums text-ink-tertiary">
          {turnCount} {turnCount === 1 ? 'turn' : 'turns'}
          {legs.length > 1 ? ` · ${legs.length} calls` : ''}
        </span>
      </div>
      {players}
      {transcriptRows}
    </>
  );

  const reasoningPane = (
    <div className="space-y-4">
      {!blocked && <EvidenceHoldNotice assessment={scorecardAssessment} />}
      {reviewCard ? (
        <ReviewScorecard
          scorecard={reviewCard}
          evidence={evidence}
          momentOf={momentOf}
          activeEvidence={pressedEvidence}
          onCue={cueEvidence}
          openMetrics={openMetrics}
          onToggleMetric={handleToggleMetric}
          checks={otherCallScorecard ? [] : drops.map(dropWords)}
          redFlags={redFlagsOf(scorecardAssessment)}
          otherCall={otherCallScorecard}
        />
      ) : !detailReady && !transcriptError && !permissionDenied && !blocked ? (
        <div role="status" aria-label="Loading the scorecard">
          <SkeletonText lines={12} gap={18} />
          <span className="sr-only">Loading the scorecard…</span>
        </div>
      ) : (
        <ScorecardBlock
          blocked={blocked}
          assessment={scorecardAssessment}
          heading={
            sessionAssessment
              ? 'Scorecard for this session'
              : permissionDenied && scorecardAssessment
                ? isR1
                  ? 'Latest phone screening scorecard'
                  : 'Latest scorecard'
                : undefined
          }
          // Empty copy only after the read succeeded: while it runs or when it
          // fails, "no scorecard" is a false statement beside a real score.
          emptyText={
            transcriptLoading
              ? 'Loading the scorecard…'
              : transcriptError
                ? "This scorecard couldn't load. Try again from the transcript."
                : permissionDenied && isR1
                  ? 'No phone screening scorecard yet.'
                  : undefined
          }
          holdNotice={false}
        />
      )}
      {/* Only the block above names the phone screening. The conflicts, role fit and summary would
          read as this role-play's, so a non-admin gets them by picking the phone session. */}
      <ScorecardNarrative assessment={blocked || (permissionDenied && isR1) ? null : scorecardAssessment} />
      {!isR1 && <FromTheResume facts={resumeFacts} />}
    </div>
  );

  return (
    <div
      ref={rootRef}
      data-review-workspace=""
      // The page does not scroll at this width; the panes do. Measured from the top of this box, since
      // the header above it wraps with the candidate's facts. Below 1180px the panes stack.
      className="-mx-4 flex flex-col sm:-mx-6 min-[1180px]:-mb-6 min-[1180px]:-mt-6 min-[1180px]:h-[calc(100dvh-var(--review-top,0px)-0.5625rem)] min-[1180px]:min-h-[34rem]"
    >
      {logHeader}
      {tape}
      <nav aria-label="Skip to a pane" className="contents">
        <a
          href="#review-transcript"
          className="sr-only focus:not-sr-only focus:mx-6 focus:my-1 focus:inline-block focus:text-meta focus:text-ink"
        >
          Skip to transcript
        </a>
        <a
          href="#review-reasoning"
          className="sr-only focus:not-sr-only focus:mx-6 focus:my-1 focus:inline-block focus:text-meta focus:text-ink"
        >
          Skip to AI recommendation
        </a>
      </nav>
      {/* `relative` on each pane: a visually hidden element inside one is absolutely positioned, and
          with no positioned ancestor it escapes the pane's clip and gives the page a scrollbar. */}
      <div className="grid min-h-0 grid-cols-1 min-[1180px]:flex-1 min-[1180px]:grid-cols-[minmax(0,55fr)_minmax(0,45fr)] min-[1180px]:grid-rows-[auto_minmax(0,1fr)]">
        {r1PlayerSlot}
        <div
          ref={transcriptPaneRef}
          id="review-transcript"
          data-review-pane="transcript"
          role="region"
          aria-label="Transcript"
          tabIndex={0}
          className="relative max-h-[36rem] min-w-0 overflow-y-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--c-accent)] min-[1180px]:col-start-1 min-[1180px]:row-span-2 min-[1180px]:row-start-1 min-[1180px]:max-h-none"
        >
          {transcriptPane}
        </div>
        <div
          ref={reasoningPaneRef}
          id="review-reasoning"
          data-review-pane="reasoning"
          role="region"
          aria-label="AI recommendation"
          tabIndex={0}
          className="relative min-w-0 border-rule-2 pb-8 pl-6 pr-6 pt-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--c-accent)] max-[1179px]:border-t min-[1180px]:col-start-2 min-[1180px]:row-start-2 min-[1180px]:overflow-y-auto min-[1180px]:border-l min-[1180px]:pl-5"
        >
          {reasoningPane}
        </div>
      </div>
    </div>
  );
}

/* ── The log header's cell, the tape's placeholder ────────────────── */

function LogCell({ label, labelId, children }: { label: string; labelId?: string; children: ReactNode }) {
  return (
    <div className="min-w-0 border-b border-rule px-6 py-1.5 sm:border-l sm:first:border-l-0 min-[1180px]:border-b-0 min-[1180px]:px-3 min-[1180px]:first:pl-6">
      <dt id={labelId} className="form-label">
        {label}
      </dt>
      <dd className="text-sm leading-5 text-ink">{children}</dd>
    </div>
  );
}

/** The strip's own height, so nothing below it moves when the session arrives. */
function TapePlaceholder() {
  return (
    <div aria-hidden="true" data-tape-placeholder="" className="border-b border-rule-2 px-6 pb-2 pt-2.5">
      <Skeleton height={28} width={220} className="block" />
      <Skeleton height={24} width="100%" className="mt-[1.75rem] block" />
      <span className="mt-1.5 block h-4" />
    </div>
  );
}

/* ── Scorecard block ──────────────────────────────────────── */

function ScorecardNarrative({ assessment, conflicts = true }: {
  assessment: Assessment | null;
  /** False where the host has already placed the conflicts. */
  conflicts?: boolean;
}) {
  // v1 shows the full legacy narrative (résumé conflicts, role fit, summary).
  // A v2 (role-scorecard) row historically carried none of these; since the
  // scorer was extended it now ALSO persists résumé conflicts + role fit (the
  // v1-shaped columns), so those two sections are shown for a v2 row too —
  // gated on the data actually being present, and null-safe for older v2 rows
  // that predate the change. The 1–10 `summary` remains v1-only.
  if (!assessment) return null;
  const v2 = isAssessmentV2(assessment);
  return (
    <>
      {conflicts && resumeConflictsOf(assessment).length > 0 && (
        <CandidateScorecardNarrative assessment={assessment} parts="conflicts" headingLevel={2} />
      )}
      {!v2 && <CandidateScorecardRoleFit assessment={assessment} headingLevel={2} />}
      {v2 && roleFitHasContent(assessment.role_fit) && (
        <CandidateScorecardRoleFit assessment={assessment} supplementary headingLevel={2} />
      )}
      {!v2 && <CandidateScorecardNarrative assessment={assessment} parts="summary" headingLevel={2} />}
    </>
  );
}

function ScorecardBlock({
  blocked,
  assessment,
  heading,
  emptyText = 'No scorecard for this session yet. One is generated when a screening completes.',
  holdNotice = true,
}: {
  blocked: boolean;
  assessment: Assessment | null;
  heading?: string;
  /** What to say when there is no assessment to show. */
  emptyText?: string;
  /** False where the host has already shown it. */
  holdNotice?: boolean;
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
        className="mb-3 text-section text-[var(--c-ink)]"
      >
        {heading ?? 'Scorecard'}
      </h2>
      {/* C3: a scorecard held for thin interview evidence says so first. */}
      {!blocked && holdNotice && <EvidenceHoldNotice assessment={assessment} />}
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
          {emptyText}
        </p>
      )}
    </section>
  );
}
