/**
 * Recording: the video, its transport and the call strip on the left, the transcript on the right.
 * One attempt each: the page keys this by session, so another attempt starts clean.
 *
 * ONE POSITION. The player, the strip, the clock and the transcript all follow it:
 *   1. The player reports the position (every frame while playing). The strip and the clock are written
 *      straight to the DOM, and the transcript renders only when the active row changes.
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
 * on the page (WCAG 2.1.4). A field keeps its own keys, and Space on a button stays that button's.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Button, EmptyPanel, InlineNotice } from '../design';
import { CallStrip } from '../recording/CallStrip';
import type { CallStripHandle, CallStripMoment, CallStripSpeaker } from '../recording/CallStrip';
import { R1RecordingPlayer } from '../r1/R1RecordingPlayer';
import type { R1RecordingPlayerHandle } from '../r1/R1RecordingPlayer';
import { activeTurnAt } from '../talent/sessionLegs';
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
  cuedRow,
  eventMarks,
  evidenceMarks,
  learnerLabel,
  phaseSegments,
  placeTurns,
  recordingBands,
  reviewDurationSec,
  rolePlayMarks,
} from '../../lib/r1-review';
import type { PlacedTurn, R1SpeakerKind } from '../../lib/r1-review';
import type { R1ReviewAssessment, R1ReviewAttempt, R1ReviewEvent } from '../../lib/r1-types';
import { PlayerControls } from './PlayerControls';
import { ReviewTranscript } from './ReviewTranscript';

const ARROW_STEP_SEC = 5;
const SKIP_STEP_SEC = 15;

/** A moment to open at. `nonce` tells a second press of the same quote from a re-render. */
export interface ReviewCue {
  sec: number | null;
  row: number | null;
  nonce: number;
}

export interface RecordingPanelProps {
  roundId: string;
  attempt: R1ReviewAttempt;
  /** "Attempt 1 (counted)": names the media for assistive technology. */
  attemptLabel: string;
  candidateName: string;
  assessment: R1ReviewAssessment | null;
  events: readonly R1ReviewEvent[];
  active: boolean;
  cue: ReviewCue | null;
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

function stripSentence(durationSec: number, speakers: readonly CallStripSpeaker[], quotes: number, moments: number): string {
  const talk = speakers.map((speaker) => `${speaker.label} took ${plural(speaker.turns.length, 'turn')}`).join(', ');
  return `The recording runs ${clockText(durationSec)}. ${talk}. ${plural(quotes, 'evidence quote')} and ${plural(moments, 'logged moment')} are marked. The transcript beside it has every turn.`;
}

export function RecordingPanel({
  roundId,
  attempt,
  attemptLabel,
  candidateName,
  assessment,
  events,
  active,
  cue,
  onNeedRefresh,
}: RecordingPanelProps) {
  const summary = attempt.recording;
  const copy = r1RecordingStateCopy(summary);
  const playable = isPlayableState(viewState(summary));

  const turns = useMemo(() => placeTurns(attempt, candidateName, assessment), [attempt, candidateName, assessment]);
  const starts = useMemo(() => turns.map((turn) => turn.startSec), [turns]);

  const [mediaSec, setMediaSec] = useState<number | null>(null);
  const durationSec = Math.max(mediaSec ?? 0, reviewDurationSec(attempt, turns));

  const [activeRow, setActiveRow] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [rate, setRate] = useState(1);

  const playerRef = useRef<R1RecordingPlayerHandle>(null);
  const stripRef = useRef<CallStripHandle>(null);
  const clockRef = useRef<HTMLSpanElement>(null);
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
    if (clockRef.current && clockRef.current.textContent !== text) clockRef.current.textContent = text;
  }, []);

  const dropHold = useCallback(() => {
    if (heldStartRef.current === null) return;
    heldStartRef.current = null;
    showRow(null);
  }, [showRow]);

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
      // No known length is no upper limit: the media stops at its own end.
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
    },
    [showPosition, showRow, summary, turns],
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

  // A quote moved focus away with the tab: land on Play, so Space or K starts it from here. The tab can
  // open after the cue (the address changes in a transition), and a hidden button takes no focus.
  useLayoutEffect(() => {
    if (!active || !focusOnPlayRef.current) return;
    focusOnPlayRef.current = false;
    playButtonRef.current?.focus({ preventScroll: true });
  }, [active, cueNonce]);

  const toggle = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    if (player.hasUrl) {
      if (playing) player.pause();
      else player.play();
      return;
    }
    // The first play starts where the reader is. Cued on a turn, it plays that turn with its lead-in.
    const sec = positionRef.current;
    const row = cuedRow(turns, sec);
    if (row !== null && turns[row].startSec === sec) playRow(row);
    else player.playFrom(sec);
  }, [playRow, playing, turns]);

  const skip = useCallback(
    (deltaSec: number) => {
      const player = playerRef.current;
      moveTo((player?.hasUrl ? player.currentTime : positionRef.current) + deltaSec);
    },
    [moveTo],
  );

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
    if (target.closest('input, select, textarea, [contenteditable="true"]')) return;
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
    ],
    [evidence, logged],
  );

  const onMoment = useCallback(
    (key: string) => {
      const row = evidence.find((mark) => `q${mark.number}` === key)?.row ?? logged.find((mark) => mark.key === key)?.row ?? null;
      if (row !== null) playRow(row);
    },
    [evidence, logged, playRow],
  );

  return (
    <div
      role="group"
      aria-label="Recording player"
      onKeyDown={onKeyDown}
      className="grid gap-6 min-[1180px]:grid-cols-[minmax(0,1fr)_26rem]"
    >
      <div className="min-w-0 space-y-3">
        {playable ? (
          <>
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
              onMediaDropped={dropHold}
              onStateChange={onNeedRefresh}
              onNeedRefresh={onNeedRefresh}
              onDuration={setMediaSec}
            />
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
                textAlternative={stripSentence(durationSec, speakers, evidence.length, logged.length)}
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
        <ReviewTranscript turns={turns} activeRow={activeRow} onSeek={playRow} visible={active} className="absolute inset-0 pt-3 min-[1180px]:pt-0" />
      </div>
    </div>
  );
}
