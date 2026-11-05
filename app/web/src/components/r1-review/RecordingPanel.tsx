/**
 * Recording: the video, its transport and the call strip on the left, the transcript and the notes on
 * the right. One attempt each: the page keys this by session, so another attempt starts clean. The page
 * holds what must not go with an attempt: the side tab, and the words of a note not yet saved.
 *
 * ONE POSITION. The player, the strip, the clock and the transcript all follow it:
 *   1. The player reports the position (every frame while playing). The strip, the clock and "Add note at"
 *      are written straight to the DOM, and the transcript renders only when the active row changes.
 *   2. The active row is the highlight rule on `TranscriptionSyncWorkspace`: the last turn in start-time
 *      order at or before the playhead (`activeTurnAt`, no tolerance).
 *   3. A click lands `R1_SEEK_LEAD_SEC` before its turn, where rule 2 would light the row before. So the
 *      clicked row lights at once and holds until the playhead reaches its start. The hold ends sooner on
 *      a scrub out of the lead-in, on the end of the file, when the media is dropped (the click failed,
 *      so no row stays lit) or when the rows change. A click the player ignores lights nothing.
 *   4. While a seek is queued the media's own reports do not count: a re-mint reloads it at 0.
 *
 * The hold ends in a layout effect, in the commit: a passive effect waits for the paint, and a click
 * on the row that commit shows could arrive first and lose its hold.
 *
 * A MOMENT CAN BE CUED BEFORE ANYTHING PLAYS. A quote from Overview, a `?t=` address or a skip moves the
 * position and lights the row, and mints nothing: the link is made by the first play, from that position.
 *
 * KEYS work while focus is inside this panel, so a single-letter shortcut never fires from elsewhere
 * on the page (WCAG 2.1.4). A field keeps its own keys, and Space on a button stays that button's. So
 * focus is brought in: a press on the tab lands on Play (the arrow keys stay with the tabs, and Tab
 * walks in from there), and the panel takes it from a click anywhere that is not a control. The tabs
 * inside this panel are the same: an arrow on Transcript or Notes moves the tab and skips nothing.
 *
 * THE PICTURE plays and pauses on a click, as native controls did. Play does the same from the keyboard.
 *
 * NOTES are a reviewer's own words at a moment (`ReviewNotes`). A note moves the position like the strip
 * does, and starts nothing: where a turn plays from its lead-in, a note goes to exactly where it was
 * pinned.
 *
 * A MOMENT ALWAYS LEADS TO ITS WORDS. A note's tick opens Notes. A quote, an evidence box or a logged tick
 * names a row, so it opens Transcript: the lit row must never sit behind the notes the reader left open.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { api } from '../../api';
import { Button, EmptyPanel, InlineNotice } from '../design';
import { CallStrip } from '../recording/CallStrip';
import type { CallStripHandle, CallStripMoment, CallStripSpeaker } from '../recording/CallStrip';
import { R1RecordingPlayer } from '../r1/R1RecordingPlayer';
import type { R1RecordingPlayerHandle } from '../r1/R1RecordingPlayer';
import { activeTurnAt } from '../talent/sessionLegs';
import { Tabs } from '../talent/Tabs';
import {
  clockText,
  inSeekLead,
  isPlayableState,
  r1RecordingStateCopy,
  turnOffsetSec,
  viewState,
} from '../../lib/r1-recording';
import {
  R1_INTERVIEWER_LABEL,
  R1_PLAYBACK_RATES,
  attemptNotes,
  cuedRow,
  eventMarks,
  evidenceMarks,
  learnerLabel,
  noteMediaMs,
  phaseSegments,
  placeTurns,
  recordingBands,
  reviewDurationSec,
  rolePlayMarks,
} from '../../lib/r1-review';
import type { PhaseSegment, PlacedTurn, R1SpeakerKind, RolePlayMark } from '../../lib/r1-review';
import type { R1ReviewAssessment, R1ReviewAttempt, R1ReviewEvent } from '../../lib/r1-types';
import { PlayerControls } from './PlayerControls';
import { ReviewNotes } from './ReviewNotes';
import type { NoteCue, NoteDraft } from './ReviewNotes';
import { ReviewTranscript } from './ReviewTranscript';
import { useRoundNotes } from './useRoundNotes';

const ARROW_STEP_SEC = 5;
const SKIP_STEP_SEC = 15;
/** Paused this close to the reader's place, the media carries on. A hold sits a lead-in short of it. */
const RESUME_SLACK_SEC = 1;

/** A moment to open at. `nonce` tells a second press of the same quote from a re-render. */
export interface ReviewCue {
  sec: number | null;
  row: number | null;
  nonce: number;
}

export interface RecordingPanelProps {
  roundId: string;
  candidateId: string;
  attempt: R1ReviewAttempt;
  /** "Attempt 1 (counted)": names the media for assistive technology. */
  attemptLabel: string;
  candidateName: string;
  assessment: R1ReviewAssessment | null;
  events: readonly R1ReviewEvent[];
  active: boolean;
  cue: ReviewCue | null;
  /** Counts presses on the Recording tab: each brings focus in here. */
  tabPress: number;
  /** The person reading. Null when that could not be read. */
  reviewerId: string | null;
  mayAddNotes: boolean;
  /** Which of Transcript and Notes is open. */
  sideTab: string;
  onSideTab: (id: string) => void;
  /** The words of unsaved notes, by session. Written here on every change, so typing renders nothing above. */
  noteDrafts: Map<string, NoteDraft>;
  onNeedRefresh: () => void;
}

function speakerRows(turns: readonly PlacedTurn[], candidateName: string, learnerName: string | null): CallStripSpeaker[] {
  const rows: Array<{ kind: R1SpeakerKind; label: string; strip: CallStripSpeaker['kind'] }> = [
    { kind: 'candidate', label: candidateName, strip: 'candidate' },
    { kind: 'interviewer', label: R1_INTERVIEWER_LABEL, strip: 'ai' },
    { kind: 'learner', label: learnerLabel(learnerName), strip: 'ai' },
  ];
  return rows.flatMap(({ kind, label, strip }) => {
    const own = turns
      .filter((turn): turn is PlacedTurn & { startSec: number } => turn.speakerKind === kind && turn.startSec !== null)
      .map((turn) => ({ startSec: turn.startSec, endSec: turn.endSec }));
    return own.length > 0 ? [{ id: kind, label, kind: strip, turns: own }] : [];
  });
}

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;

function stripSentence(
  durationSec: number,
  speakers: readonly CallStripSpeaker[],
  phases: readonly PhaseSegment[],
  marks: readonly RolePlayMark[],
  quotes: number,
  moments: number,
  notes: number,
): string {
  const talk = speakers.map((speaker) => `${speaker.label} took ${plural(speaker.turns.length, 'turn')}`).join(', ');
  const stages = phases.map((phase) => `${phase.label} from ${clockText(phase.startSec)}`).join(', ');
  const lines = marks.map((mark) => `${mark.detail} at ${clockText(mark.sec)}`).join(', ');
  const counted = notes > 0 ? `, ${plural(moments, 'logged moment')} and ${plural(notes, 'note')}` : ` and ${plural(moments, 'logged moment')}`;
  return [
    `The recording runs ${clockText(durationSec)}.`,
    talk && `${talk}.`,
    stages && `Phases: ${stages}.`,
    lines && `${lines}.`,
    `${plural(quotes, 'evidence quote')}${counted} are marked. The transcript beside it has every turn.`,
  ]
    .filter(Boolean)
    .join(' ');
}

export function RecordingPanel({
  roundId,
  candidateId,
  attempt,
  attemptLabel,
  candidateName,
  assessment,
  events,
  active,
  cue,
  tabPress,
  reviewerId,
  mayAddNotes,
  sideTab,
  onSideTab,
  noteDrafts,
  onNeedRefresh,
}: RecordingPanelProps) {
  const summary = attempt.recording;
  const copy = r1RecordingStateCopy(summary);
  const playable = isPlayableState(viewState(summary));

  const turns = useMemo(() => placeTurns(attempt, candidateName, assessment), [attempt, candidateName, assessment]);
  const starts = useMemo(() => turns.map((turn) => turn.startSec), [turns]);

  const { state: roundNotes, retry: readNotesAgain, add: keepNote } = useRoundNotes(roundId);
  const notes = useMemo(
    () => (roundNotes.status === 'ready' ? attemptNotes(roundNotes.notes, attempt.session_id) : null),
    [roundNotes, attempt.session_id],
  );

  const [mediaSec, setMediaSec] = useState<number | null>(null);
  const durationSec = Math.max(mediaSec ?? 0, reviewDurationSec(attempt, turns, notes ?? []));

  const [activeRow, setActiveRow] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [rate, setRate] = useState(1);
  const [noteCue, setNoteCue] = useState<NoteCue | null>(null);

  const playerRef = useRef<R1RecordingPlayerHandle>(null);
  const stripRef = useRef<CallStripHandle>(null);
  const clockRef = useRef<HTMLSpanElement>(null);
  const noteClockRef = useRef<HTMLSpanElement>(null);
  const playButtonRef = useRef<HTMLButtonElement>(null);
  const positionRef = useRef(0);
  const activeRowRef = useRef<number | null>(null);
  const heldStartRef = useRef<number | null>(null);

  const showRow = useCallback((row: number | null) => {
    if (activeRowRef.current === row) return;
    activeRowRef.current = row;
    setActiveRow(row);
  }, []);

  const showPosition = useCallback((sec: number) => {
    positionRef.current = sec;
    stripRef.current?.movePlayhead(sec);
    const text = clockText(sec);
    for (const clock of [clockRef.current, noteClockRef.current]) {
      if (clock && clock.textContent !== text) clock.textContent = text;
    }
  }, []);

  const playheadSec = useCallback(() => positionRef.current, []);

  const dropHold = useCallback(() => {
    if (heldStartRef.current === null) return;
    heldStartRef.current = null;
    showRow(null);
  }, [showRow]);

  // A dropped element never sends its pause, so the transport is told here.
  const onMediaDropped = useCallback(() => {
    setPlaying(false);
    dropHold();
  }, [dropHold]);

  // A hold belongs to the rows it was clicked on: new rows end it (see the file header).
  useLayoutEffect(dropHold, [starts, dropHold]);

  const onPosition = useCallback(
    (sec: number) => {
      // A queued seek has not moved the media yet, so this position says nothing about where it will be.
      if (playerRef.current?.seekQueued) return;
      showPosition(sec);
      const held = heldStartRef.current;
      if (held !== null) {
        if (inSeekLead(held, sec)) return;
        heldStartRef.current = null;
      }
      showRow(activeTurnAt(starts, sec));
    },
    [showPosition, showRow, starts],
  );

  const onEnded = useCallback(
    (sec: number) => {
      // The old file ran out while its link was being replaced: the seek is still on its way.
      if (playerRef.current?.seekQueued) return;
      heldStartRef.current = null;
      onPosition(sec);
    },
    [onPosition],
  );

  /** Play from a turn, with the lead-in, and light it at once. */
  const playRow = useCallback(
    (row: number) => {
      const turn = turns[row];
      const startedAt = turn?.turn_started_at_ms;
      if (typeof startedAt !== 'number' || turn.startSec === null) return;
      if (!playerRef.current?.playFromTurn(startedAt)) return;
      heldStartRef.current = turn.startSec;
      showPosition(turn.startSec);
      showRow(row);
    },
    [showPosition, showRow, turns],
  );

  /** Move the position without starting anything. With no link yet, nothing is minted. */
  const moveTo = useCallback(
    (sec: number) => {
      // The scale reaches every turn and note, so each lands where it says. No scale is no upper limit: the
      // media stops at its own end.
      const target = Math.min(durationSec > 0 ? durationSec : Number.POSITIVE_INFINITY, Math.max(0, sec));
      heldStartRef.current = null;
      if (playerRef.current?.hasUrl) playerRef.current.seek(target);
      showPosition(target);
      showRow(activeTurnAt(starts, target));
    },
    [durationSec, showPosition, showRow, starts],
  );

  /** Open a moment from elsewhere on the page. */
  const openCue = useCallback(
    (sec: number | null, row: number | null) => {
      const startedAt = row === null ? null : turns[row]?.turn_started_at_ms;
      if (sec !== null && row !== null && playerRef.current?.hasUrl && typeof startedAt === 'number') {
        const offset = turnOffsetSec(startedAt, summary);
        if (offset !== null) playerRef.current.seek(offset);
        heldStartRef.current = sec;
      }
      if (sec !== null) showPosition(sec);
      showRow(row ?? (sec === null ? null : cuedRow(turns, sec)));
      if (row !== null) onSideTab('transcript');
    },
    [onSideTab, showPosition, showRow, summary, turns],
  );

  const cueNonce = cue?.nonce ?? null;
  const openedCueRef = useRef<number | null>(null);
  const focusOnPlayRef = useRef(false);
  useLayoutEffect(() => {
    if (!cue || cueNonce === null || openedCueRef.current === cueNonce) return;
    openedCueRef.current = cueNonce;
    openCue(cue.sec, cue.row);
    focusOnPlayRef.current = cueNonce > 0;
  }, [cue, cueNonce, openCue]);

  const tabPressRef = useRef(tabPress);
  useLayoutEffect(() => {
    if (tabPressRef.current === tabPress) return;
    tabPressRef.current = tabPress;
    focusOnPlayRef.current = true;
  }, [tabPress]);

  // A quote or a press on the tab left focus outside: land on Play, so Space or K starts it from here. The
  // tab can open after the cue (the address changes in a transition), and a hidden button takes no focus.
  useLayoutEffect(() => {
    if (!active || !focusOnPlayRef.current) return;
    focusOnPlayRef.current = false;
    playButtonRef.current?.focus({ preventScroll: true });
  }, [active, cueNonce, tabPress]);

  const toggle = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    if (player.hasUrl && !player.paused) {
      player.pause();
      return;
    }
    const sec = positionRef.current;
    if (player.hasUrl && Math.abs(player.currentTime - sec) < RESUME_SLACK_SEC) {
      player.play();
      return;
    }
    // The first play starts where the reader is. So does a play after a click whose link failed: Try
    // again brings the media back at the start, and the reader is still on the turn they asked for.
    // Cued on a turn, it plays that turn with its lead-in.
    const row = cuedRow(turns, sec);
    if (row !== null && turns[row].startSec === sec) playRow(row);
    else player.playFrom(sec);
  }, [playRow, turns]);

  const onPictureClick = (event: MouseEvent<HTMLDivElement>) => {
    // Try again is its own button, and an error block is not the picture.
    if ((event.target as HTMLElement).closest('button, [role="alert"]')) return;
    toggle();
  };

  const skip = useCallback((deltaSec: number) => moveTo(positionRef.current + deltaSec), [moveTo]);

  const changeRate = useCallback((next: number) => {
    setRate(next);
    playerRef.current?.setRate(next);
  }, []);

  const changeMuted = useCallback((next: boolean) => {
    setMuted(next);
    playerRef.current?.setMuted(next);
  }, []);

  const changeVolume = useCallback((next: number) => {
    setVolume(next);
    playerRef.current?.setVolume(next);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey || !playable) return;
    const target = event.target as HTMLElement;
    // The speed list has its own arrow keys and letters.
    if (target.closest('input, select, textarea, [contenteditable="true"], [aria-haspopup="listbox"], [role="listbox"]')) return;
    // The arrows on a tab are the tab's own: one press must not also skip the recording.
    if (event.key.startsWith('Arrow') && target.closest('[role="tab"]')) return;
    const step = R1_PLAYBACK_RATES.indexOf(rate as (typeof R1_PLAYBACK_RATES)[number]);
    switch (event.key.toLowerCase()) {
      case ' ':
        if (target.closest('button, a')) return;
        toggle();
        break;
      case 'k':
        toggle();
        break;
      case 'j':
        skip(-SKIP_STEP_SEC);
        break;
      case 'l':
        skip(SKIP_STEP_SEC);
        break;
      case 'arrowleft':
        skip(-ARROW_STEP_SEC);
        break;
      case 'arrowright':
        skip(ARROW_STEP_SEC);
        break;
      case '[':
        changeRate(R1_PLAYBACK_RATES[Math.max(0, step - 1)]);
        break;
      case ']':
        changeRate(R1_PLAYBACK_RATES[Math.min(R1_PLAYBACK_RATES.length - 1, step + 1)]);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const speakers = useMemo(() => speakerRows(turns, candidateName, attempt.learner_name), [turns, candidateName, attempt.learner_name]);
  const segments = useMemo(() => phaseSegments(turns, durationSec), [turns, durationSec]);
  const markers = useMemo(() => rolePlayMarks(segments), [segments]);
  const evidence = useMemo(
    () => (assessment?.session_id === attempt.session_id ? evidenceMarks(assessment, turns) : []),
    [assessment, attempt.session_id, turns],
  );
  const logged = useMemo(() => eventMarks(events, attempt.session_id, turns), [events, attempt.session_id, turns]);
  const noteMoments = useMemo<CallStripMoment[]>(
    () =>
      (notes ?? []).flatMap((note) =>
        note.sec === null ? [] : [{ key: `n${note.id}`, sec: note.sec, kind: 'note' as const, label: `Note, ${clockText(note.sec)}` }],
      ),
    [notes],
  );
  const moments = useMemo<CallStripMoment[]>(
    () => [
      ...evidence.flatMap((mark) =>
        mark.startSec === null
          ? []
          : [{ key: `q${mark.number}`, sec: mark.startSec, kind: 'evidence' as const, number: mark.number, label: `Evidence ${mark.number}, ${mark.metric}, ${clockText(mark.startSec)}` }],
      ),
      ...logged.flatMap((mark) =>
        mark.startSec === null ? [] : [{ key: mark.key, sec: mark.startSec, kind: 'event' as const, label: `${mark.label}, ${clockText(mark.startSec)}` }],
      ),
      ...noteMoments,
    ],
    [evidence, logged, noteMoments],
  );

  const noteCueNonceRef = useRef(0);
  const onMoment = useCallback(
    (key: string) => {
      const note = notes?.find((item) => `n${item.id}` === key);
      if (note && note.sec !== null) {
        moveTo(note.sec);
        onSideTab('notes');
        noteCueNonceRef.current += 1;
        setNoteCue({ id: note.id, nonce: noteCueNonceRef.current });
        return;
      }
      const row = evidence.find((mark) => `q${mark.number}` === key)?.row ?? logged.find((mark) => mark.key === key)?.row ?? null;
      if (row === null) return;
      playRow(row);
      onSideTab('transcript');
    },
    [evidence, logged, moveTo, notes, onSideTab, playRow],
  );

  const addNote = useCallback(
    async (text: string, sec: number | null) => {
      const anchor = { round_id: roundId, session_id: attempt.session_id };
      keepNote(await api.addNote(candidateId, text, sec === null ? anchor : { ...anchor, media_ms: noteMediaMs(sec) }));
    },
    [attempt.session_id, candidateId, keepNote, roundId],
  );

  const keepDraft = useCallback(
    (draft: NoteDraft | null) => {
      if (draft) noteDrafts.set(attempt.session_id, draft);
      else noteDrafts.delete(attempt.session_id);
    },
    [attempt.session_id, noteDrafts],
  );

  return (
    <div
      role="group"
      aria-label="Recording player"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="grid gap-6 focus:outline-none min-[1180px]:grid-cols-[minmax(0,1fr)_26rem]"
    >
      <div className="min-w-0 space-y-3">
        {playable ? (
          <>
            <div onClick={onPictureClick} className="cursor-pointer">
              <R1RecordingPlayer
                ref={playerRef}
                roundId={roundId}
                sessionId={attempt.session_id}
                summary={summary}
                label={attemptLabel}
                active={active}
                controls="custom"
                onTimeUpdate={onPosition}
                onPlayState={setPlaying}
                onEnded={onEnded}
                onMediaDropped={onMediaDropped}
                onStateChange={onNeedRefresh}
                onNeedRefresh={onNeedRefresh}
                onDuration={setMediaSec}
              />
            </div>
            <PlayerControls
              playing={playing}
              muted={muted}
              volume={volume}
              rate={rate}
              lengthSec={durationSec}
              initialSec={0}
              positionRef={clockRef}
              playRef={playButtonRef}
              onToggle={toggle}
              onSkip={skip}
              onMuted={changeMuted}
              onVolume={changeVolume}
              onRate={changeRate}
            />
            {durationSec > 0 && (
              <CallStrip
                ref={stripRef}
                durationSec={durationSec}
                speakers={speakers}
                phases={segments}
                markers={markers}
                markersLabel="Role-play clock"
                moments={moments}
                bands={recordingBands(summary, durationSec)}
                textAlternative={stripSentence(durationSec, speakers, segments, markers, evidence.length, logged.length, noteMoments.length)}
                onSeek={moveTo}
                onMoment={onMoment}
                className="border-t border-line pt-3"
              />
            )}
            {copy.notice && (
              <InlineNotice tone="warning" role="none">
                {copy.notice}
              </InlineNotice>
            )}
          </>
        ) : (
          <EmptyPanel
            title={copy.tag}
            hint={copy.detail}
            action={
              copy.action === 'refresh' ? (
                <Button variant="secondary" size="sm" onClick={onNeedRefresh}>
                  Check again
                </Button>
              ) : undefined
            }
          />
        )}
      </div>

      {/* The rows scroll in a box as tall as the left column, and never shorter than the window allows. */}
      <div className="relative min-h-[28rem] min-w-0 border-t border-line pt-3 min-[1180px]:min-h-[calc(100vh-15rem)] min-[1180px]:border-l min-[1180px]:border-t-0 min-[1180px]:pt-0">
        <Tabs
          ariaLabel="Transcript and notes"
          selectedId={sideTab}
          onSelect={onSideTab}
          className="absolute inset-0 flex flex-col pt-3 min-[1180px]:pt-0"
          listClassName="shrink-0 px-4"
          panelClassName="relative min-h-0 flex-1"
          items={[
            {
              id: 'transcript',
              label: 'Transcript',
              panel: (
                <ReviewTranscript
                  turns={turns}
                  activeRow={activeRow}
                  onSeek={playRow}
                  visible={active && sideTab === 'transcript'}
                  emptyText={attempt.in_progress ? 'The transcript appears here once the interview ends.' : undefined}
                  className="absolute inset-0 pt-3"
                />
              ),
            },
            {
              id: 'notes',
              label: 'Notes',
              panel: (
                <ReviewNotes
                  notes={notes}
                  failed={roundNotes.status === 'failed'}
                  reviewerId={reviewerId}
                  mayAdd={mayAddNotes}
                  positionSec={playable ? playheadSec : null}
                  clockRef={noteClockRef}
                  cue={noteCue}
                  keptDraft={noteDrafts.get(attempt.session_id) ?? null}
                  onDraft={keepDraft}
                  onSeek={moveTo}
                  onAdd={addNote}
                  onRetry={readNotesAgain}
                  className="absolute inset-0 pt-3"
                />
              ),
            },
          ]}
        />
      </div>
    </div>
  );
}
