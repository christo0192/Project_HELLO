/**
 * CallStrip: a call drawn to its own scale, under the player. Logsheet's signature.
 *
 * What each mark means, and nothing else (docs/design/hello-glass-design-system.md):
 *   - the candidate's turns are grease-pencil orange, the AI voices warm grey, in a row each;
 *   - a turn is a TICK at its start. A talk BAR needs a stored end time: drawing start-to-next-start
 *     would show every silence as talk, so a turn with no end stays a tick;
 *   - an evidence quote is a numbered ink box and a logged moment a plain ink tick, in the Moments row;
 *   - a reviewer's note is a small ink flag in a Notes row of its own: quotes can fill every lane of
 *     Moments, and a flag drawn under a box could not be pressed. The row is one lane high however close
 *     the notes sit, because reviewers pin them close and lanes would push the strip off the first
 *     screen. Crowded flags overlap: each is still a tab stop, and a row in the Notes list;
 *   - a band is a dashed "pencil" outline with its word: part of the recording is not firm;
 *   - the playhead is an ink line.
 *
 * Reusable: it knows nothing about R1. A host passes seconds and words.
 *
 * Nothing here animates, and the playhead moves by writing to the DOM (`movePlayhead`), so a player
 * that reports every frame costs no render. Cueing a moment is instant.
 *
 * The rail lies under the rows. Whatever carries a tooltip (a phase, a marker) answers the pointer
 * itself, or the tooltip could never show, and passes its click on to the same seek.
 *
 * Keyboard and screen readers. The rail is a slider: arrows step 5 s, Home and End go to either end.
 * The turn ticks are decoration a transcript repeats in full, so they are hidden from assistive
 * technology and take no tab stop (an interview has a hundred of them); a moment is a real button
 * with a name; `textAlternative` says what the picture says. The marks are fills, which forced colours
 * would drop, so each carries `data-mark` and index.css draws it in `CanvasText`.
 */
import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { cx } from '../design/cx';
import { clockText } from '../../lib/r1-recording';
import { along, assignLanes, axisSteps, snapToTick } from './call-strip-scale';

export interface CallStripTurn {
  startSec: number;
  /** A stored end time. Absent: the turn is drawn as a tick, never as a bar. */
  endSec?: number | null;
}

export interface CallStripSpeaker {
  id: string;
  label: string;
  /** `candidate` is the one orange row; `ai` is warm grey. */
  kind: 'candidate' | 'ai';
  turns: readonly CallStripTurn[];
}

export interface CallStripPhase {
  label: string;
  startSec: number;
  endSec: number;
}

export interface CallStripMarker {
  sec: number;
  label: string;
  detail?: string;
}

export interface CallStripMoment {
  key: string;
  sec: number;
  kind: 'evidence' | 'event' | 'note';
  /** The evidence number printed in the box. */
  number?: number;
  /** The button's accessible name, and its tooltip. */
  label: string;
}

export interface CallStripBand {
  startSec: number;
  endSec: number;
  label: string;
}

export interface CallStripProps {
  durationSec: number;
  speakers: readonly CallStripSpeaker[];
  phases: readonly CallStripPhase[];
  markers?: readonly CallStripMarker[];
  /** What `markers` are readings of, printed beside them. */
  markersLabel?: string;
  moments?: readonly CallStripMoment[];
  bands?: readonly CallStripBand[];
  /** Says in words what the strip shows: length, who spoke, what is marked. */
  textAlternative: string;
  /** Where the playhead starts. It moves by `movePlayhead` after that. */
  initialSec?: number;
  onSeek: (sec: number) => void;
  onMoment?: (key: string) => void;
  className?: string;
}

export interface CallStripHandle {
  movePlayhead(sec: number): void;
}

const LABEL_COLUMN = 'w-[8.5rem] shrink-0';
const SNAP_PX = 4;
const STEP_SEC = 5;
/** Two moment boxes closer than this share no lane: a box is 16 px wide. */
const MOMENT_GAP_PX = 20;
const LANE_PX = 20;
/** Narrower than this a phase's word would be cut to a letter or two, so it stays a tooltip. */
const PHASE_LABEL_MIN_PERCENT = 12;

const percent = (value: number) => `${value}%`;

interface MomentRow {
  label: string;
  moments: readonly CallStripMoment[];
  lanes: readonly number[];
  heightPx: number;
}

function momentRow(label: string, unsorted: readonly CallStripMoment[], lanesOf: (secs: number[]) => number[]): MomentRow {
  const moments = [...unsorted].sort((a, b) => a.sec - b.sec);
  const lanes = lanesOf(moments.map((moment) => moment.sec));
  return { label, moments, lanes, heightPx: (Math.max(-1, ...lanes) + 1) * LANE_PX };
}

export const CallStrip = forwardRef<CallStripHandle, CallStripProps>(function CallStrip(
  {
    durationSec,
    speakers,
    phases,
    markers = [],
    markersLabel,
    moments = [],
    bands = [],
    textAlternative,
    initialSec = 0,
    onSeek,
    onMoment,
    className,
  },
  ref,
) {
  const [speakersShown, setSpeakersShown] = useState(true);
  const playheadRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const positionRef = useRef(initialSec);

  const movePlayhead = useCallback(
    (sec: number) => {
      positionRef.current = sec;
      if (playheadRef.current) playheadRef.current.style.left = percent(along(sec, durationSec));
      const whole = Math.floor(sec);
      const rail = railRef.current;
      if (rail && rail.getAttribute('aria-valuenow') !== String(whole)) {
        rail.setAttribute('aria-valuenow', String(whole));
        rail.setAttribute('aria-valuetext', clockText(whole));
      }
    },
    [durationSec],
  );

  useImperativeHandle(ref, () => ({ movePlayhead }), [movePlayhead]);

  // A new scale (the media's own length arrived) redraws from the props: put the playhead back.
  useLayoutEffect(() => movePlayhead(positionRef.current), [movePlayhead]);

  const ticks = useMemo(() => speakers.flatMap((speaker) => speaker.turns.map((turn) => turn.startSec)), [speakers]);

  const seekAt = (event: MouseEvent<HTMLElement>) => {
    const box = railRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0 || durationSec <= 0) return;
    const sec = ((event.clientX - box.left) / box.width) * durationSec;
    const snapped = snapToTick(sec, ticks, (SNAP_PX / box.width) * durationSec);
    onSeek(Math.min(durationSec, Math.max(0, snapped)));
  };

  const onRailKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const steps: Record<string, number> = {
      ArrowRight: positionRef.current + STEP_SEC,
      ArrowLeft: positionRef.current - STEP_SEC,
      Home: 0,
      End: durationSec,
    };
    const target = steps[event.key];
    if (target === undefined) return;
    event.preventDefault();
    // The host's own keys step too: one press is one step.
    event.stopPropagation();
    onSeek(Math.min(durationSec, Math.max(0, target)));
  };

  const momentRows = useMemo(
    () =>
      [
        momentRow('Moments', moments.filter((moment) => moment.kind !== 'note'), (secs) => assignLanes(secs, durationSec, MOMENT_GAP_PX)),
        momentRow('Notes', moments.filter((moment) => moment.kind === 'note'), (secs) => secs.map(() => 0)),
      ].filter((row) => row.moments.length > 0),
    [moments, durationSec],
  );
  const rowLabel = 'form-label flex items-center truncate';

  return (
    <figure role="group" aria-label="Call strip" data-call-strip="" className={cx('text-ink-secondary', className)}>
      <figcaption className="sr-only">{textAlternative}</figcaption>

      <div className="flex">
        {/* The label column. Every row here has the height of its track on the right. */}
        <div className={cx(LABEL_COLUMN, 'pr-3')}>
          <div className={cx(rowLabel, 'h-6')}>Phases</div>
          {speakersShown &&
            speakers.map((speaker) => (
              <div
                key={speaker.id}
                title={speaker.label}
                className={cx(rowLabel, 'h-5', speaker.kind === 'candidate' && 'font-semibold text-voice')}
              >
                <span className="truncate">{speaker.label}</span>
              </div>
            ))}
          {momentRows.map((row) => (
            <div key={row.label} className={rowLabel} style={{ height: row.heightPx }}>
              {row.label}
            </div>
          ))}
          {bands.length > 0 && <div className={cx(rowLabel, 'h-5')}>Recording</div>}
          {markers.length > 0 && <div className={cx(rowLabel, 'h-5')}>{markersLabel}</div>}
          {/* In the axis row's empty cell: the toggle costs the strip no height of its own. */}
          <div className="flex h-5 items-center">
            <button
              type="button"
              onClick={() => setSpeakersShown((shown) => !shown)}
              className="rounded-evidence text-meta text-ink-secondary underline underline-offset-2 hover:text-ink focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--ink)]"
            >
              {speakersShown ? 'Hide speakers' : 'Show speakers'}
            </button>
          </div>
        </div>

        <div className="relative min-w-0 flex-1">
          <div
            ref={railRef}
            role="slider"
            tabIndex={0}
            aria-label="Position in the recording"
            aria-valuemin={0}
            aria-valuemax={Math.floor(durationSec)}
            aria-valuenow={Math.floor(initialSec)}
            aria-valuetext={clockText(initialSec)}
            onClick={seekAt}
            onKeyDown={onRailKey}
            className="absolute inset-0 cursor-pointer rounded-evidence focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ink)]"
          />

          <div className="pointer-events-none relative h-6">
            {phases.map((phase) => (
              <span
                key={`${phase.label}-${phase.startSec}`}
                data-phase=""
                title={phase.label}
                onClick={seekAt}
                style={{
                  left: percent(along(phase.startSec, durationSec)),
                  width: percent(along(phase.endSec, durationSec) - along(phase.startSec, durationSec)),
                }}
                className="pointer-events-auto absolute inset-y-1 cursor-pointer overflow-hidden truncate border-l border-[var(--control)] bg-surface-secondary px-1 text-meta leading-4 text-ink-tertiary"
              >
                {along(phase.endSec, durationSec) - along(phase.startSec, durationSec) >= PHASE_LABEL_MIN_PERCENT ? phase.label : null}
              </span>
            ))}
          </div>

          {speakersShown &&
            speakers.map((speaker) => (
              <div key={speaker.id} data-speaker={speaker.id} className="pointer-events-none relative h-5 border-b border-line">
                {speaker.turns.map((turn, index) => {
                  const hasEnd = typeof turn.endSec === 'number' && turn.endSec > turn.startSec;
                  const left = percent(along(turn.startSec, durationSec));
                  const fill = speaker.kind === 'candidate' ? 'bg-voice-mark' : 'bg-ai';
                  // The candidate's mark is full height, the AI's a third: height tells them apart
                  // where colour cannot (the pair is 1.15:1), and in forced colours.
                  const height = speaker.kind === 'candidate' ? 'top-0.5 bottom-0' : 'bottom-0 h-1.5';
                  return hasEnd ? (
                    <span
                      key={index}
                      data-talk-bar=""
                      data-mark=""
                      aria-hidden="true"
                      style={{ left, width: percent(along(turn.endSec as number, durationSec) - along(turn.startSec, durationSec)) }}
                      className={cx('absolute', height, fill)}
                    />
                  ) : (
                    <span
                      key={index}
                      data-turn-tick=""
                      data-mark=""
                      aria-hidden="true"
                      style={{ left }}
                      className={cx('absolute w-px', height, fill)}
                    />
                  );
                })}
              </div>
            ))}

          {momentRows.map((row) => (
            <div key={row.label} data-moment-row={row.label} className="pointer-events-none relative" style={{ height: row.heightPx }}>
              {row.moments.map((moment, index) => (
                <button
                  key={moment.key}
                  type="button"
                  aria-label={moment.label}
                  title={moment.label}
                  onClick={() => onMoment?.(moment.key)}
                  style={{ left: percent(along(moment.sec, durationSec)), top: row.lanes[index] * LANE_PX + 2 }}
                  className={cx(
                    'pointer-events-auto absolute flex h-4 -translate-x-1/2 items-center justify-center rounded-evidence font-mono text-meta leading-none text-ink',
                    'focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--ink)]',
                    moment.kind === 'evidence'
                      ? 'min-w-4 border border-ink bg-surface px-0.5 hover:bg-ink hover:text-surface'
                      : 'w-3 hover:bg-surface-secondary',
                    // Flags can overlap: the one under the pointer or the focus comes to the front.
                    moment.kind === 'note' && 'hover:z-10 focus-visible:z-10',
                  )}
                >
                  {moment.kind === 'evidence' ? (
                    moment.number
                  ) : moment.kind === 'note' ? (
                    <span data-note-flag="" aria-hidden="true" className="relative h-2.5 w-2">
                      <span data-mark="" className="absolute inset-y-0 left-0 w-px bg-ink" />
                      <span data-mark="" className="absolute left-0 top-0 h-1.5 w-2 bg-ink" />
                    </span>
                  ) : (
                    <span data-mark="" aria-hidden="true" className="h-2.5 w-px bg-ink" />
                  )}
                </button>
              ))}
            </div>
          ))}

          {bands.length > 0 && (
            <div className="pointer-events-none relative h-5">
              {bands.map((band) => (
                <span
                  key={`${band.label}-${band.startSec}`}
                  data-band=""
                  style={{
                    left: percent(along(band.startSec, durationSec)),
                    width: percent(along(band.endSec, durationSec) - along(band.startSec, durationSec)),
                  }}
                  className="absolute inset-y-0.5 truncate rounded-evidence border border-dashed border-ink-secondary px-1 text-meta leading-3 text-ink-secondary"
                >
                  {band.label}
                </span>
              ))}
            </div>
          )}

          {markers.length > 0 && (
            <div className="pointer-events-none relative h-5">
              {markers.map((marker) => (
                <span
                  key={marker.label}
                  data-marker=""
                  title={marker.detail}
                  onClick={seekAt}
                  style={{ left: percent(along(marker.sec, durationSec)) }}
                  className="pointer-events-auto absolute top-0.5 -translate-x-1/2 cursor-pointer bg-surface px-0.5 font-mono text-meta text-ink"
                >
                  {marker.label}
                </span>
              ))}
            </div>
          )}

          <div className="pointer-events-none relative h-5" aria-hidden="true">
            {axisSteps(durationSec).map((sec, index) => (
              <span
                key={sec}
                style={{ left: percent(along(sec, durationSec)) }}
                className={cx(
                  'absolute top-1 font-mono text-meta text-ink-tertiary',
                  sec === 0 ? '' : along(sec, durationSec) > 94 ? '-translate-x-full' : '-translate-x-1/2',
                  // On a phone the track is too narrow to print every step.
                  index % 2 === 1 && 'max-sm:hidden',
                )}
              >
                {clockText(sec)}
              </span>
            ))}
          </div>

          {markers.map((marker) => (
            <span
              key={marker.label}
              aria-hidden="true"
              style={{ left: percent(along(marker.sec, durationSec)) }}
              className="pointer-events-none absolute bottom-10 top-0 w-px border-l border-dashed border-ink-tertiary"
            />
          ))}

          <div
            ref={playheadRef}
            data-playhead=""
            data-mark=""
            aria-hidden="true"
            style={{ left: percent(along(initialSec, durationSec)) }}
            className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-ink"
          />
        </div>
      </div>

    </figure>
  );
});
