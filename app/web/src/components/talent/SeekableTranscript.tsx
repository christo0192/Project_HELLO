/**
 * SeekableTranscript: the transcript as a log sheet.
 *
 * Each turn is one ruled row: its timecode and turn number in a printed margin, the speaker in a
 * narrow column, then the words. Cited words sit in a `<mark>` with the highlighter wash, and the
 * turn says what it was cited for beside each evidence number. A wash is never the only marker: the
 * number, the strip tick and the quote button all say the same thing.
 *
 * - A timed turn's timecode is a real <button>, even before the recording is loaded. Pressing it
 *   calls onSeek(offsetSec, rowIndex); the workspace handles minting the URL and queuing the seek.
 *   The turn's words are plain text, so they can be read and selected.
 * - An untimed turn has no button and a clear "no timing data" label.
 * - The active turn's timecode carries aria-current="true", a filled marker and an ink weight, its
 *   row a shaded field, and a screen reader hears it through aria-live: "Now playing" for a turn that
 *   can play, and for one that cannot, the turn and the reason.
 * - Cueing is instant: the row comes into view with no animation.
 */

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { TranscriptLine } from '../../types';
import { cx } from '../design/cx';
import { evidenceNumberClass, type JudgementFamily } from '../design/tones';
import { SkeletonText } from '../design/Skeleton';
import { presentTranscriptTurn } from '../../lib/transcript-presentation';
import { formatIstTime } from '../../lib/ist-datetime';
import { markedSpans } from '../../lib/evidence-quotes';
import { timecode } from '../recording/callStripGeometry';
import { EvidenceMark } from './EvidenceMark';

/** A turn's time when it cannot seek: seconds into its call, or a clock time. */
export interface TurnTime {
  sec?: number | null;
  atMs?: number | null;
}

/** A quote that stands in a turn. Offsets are into the turn's own text. */
export interface TurnEvidence {
  number: number;
  metricName: string;
  start: number;
  end: number;
  /** The family of the rating it cites. A metric with no score has none, and stays ink. */
  family?: JudgementFamily | null;
}

/** The consent gate, folded into one line. Indexes are rows of this list. */
export interface ConsentFold {
  firstIndex: number;
  lastIndex: number;
  /** "Consent given at 00:20": the form Legal approved, for the phone Review screen only. */
  line: string;
  /** "Show 4 turns". */
  showLabel: string;
  /** Where the first folded row sits on the call. */
  atSec: number | null;
  /** That time is an estimate, and prints "≈" as every other row of the call does. */
  approximate: boolean;
  /** The T numbers in the margin, "T1–4". */
  turnsLabel: string;
  onShow: () => void;
}

export interface SeekableTranscriptProps {
  transcript: TranscriptLine[];
  activeTurnIndex: number | null;
  /** `rowIndex` is the clicked row's place in `transcript`: two rows can share an offset. */
  onSeek: (offsetSec: number, rowIndex: number) => void;
  recordingReady: boolean;
  isLoading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  className?: string;
  /**
   * M013 S02: the offsets are an ESTIMATE (a legacy leg placed from its
   * answer time). Each timestamp reads "≈0:12" and "At about 0:12".
   */
  approximateTiming?: boolean;
  /**
   * M013 S02: the session-wide turn number of each row, when this list is
   * one leg's slice of the transcript. Defaults to the row position + 1.
   */
  turnNumbers?: readonly number[];
  /**
   * Per-row display time for a turn that has a time but no seek offset (its
   * call's recording cannot be played). Shown as "m:ss" into the call, else an
   * IST clock time, instead of "no timing data".
   */
  turnTimes?: readonly (TurnTime | null | undefined)[];
  /** Why timed-but-not-seekable turns cannot start playback; read by AT. */
  unseekableReason?: string | null;
  /** What to call each speaker. Defaults to the AI speaker label and "Candidate". */
  speakers?: { bot: string; candidate: string };
  /**
   * Per-row time to print, in seconds along the whole call. A row's seek offset is into its own
   * call's file, so the margin and the strip agree only through this. Defaults to that offset.
   */
  clock?: readonly (number | null | undefined)[];
  /** The quotes standing in each row, by row index. */
  evidence?: ReadonlyMap<number, readonly TurnEvidence[]>;
  /** The evidence number that is cued. */
  activeEvidence?: number | null;
  onEvidence?: (number: number) => void;
  /** Fold these rows into the consent line, until it is opened. */
  consent?: ConsentFold | null;
  /** False while the active row is only where Review opened: nothing is playing, so nothing is said. */
  announce?: boolean;
  /** A new value brings the active row into view even when it did not change. See `TranscriptReveal`. */
  reveal?: TranscriptReveal;
}

/**
 * A request to bring the active row into view. A press needs this as well as a change of row: the same
 * quote pressed again, or a second quote in the same turn, moves nothing and must still land on screen.
 */
export interface TranscriptReveal {
  seq: number;
  /**
   * Into the window too. Below 1180px the panes stack and the page scrolls, so a press in the reasoning
   * pane can leave the row off-screen. False for playback, which must not pull the page away from a
   * reader, and for the tab showing again.
   */
  intoWindow: boolean;
}

function hasTiming(t: TranscriptLine): boolean {
  return t.start_offset_sec != null;
}

/** The label for a turn's non-seekable time, or null when it has none. */
function displayTime(time: TurnTime | null | undefined): { text: string; spoken: string } | null {
  if (!time) return null;
  if (typeof time.sec === 'number' && Number.isFinite(time.sec)) {
    const text = timecode(time.sec);
    return { text, spoken: `${text} into the call` };
  }
  if (typeof time.atMs === 'number' && Number.isFinite(time.atMs)) {
    const text = formatIstTime(new Date(time.atMs).toISOString());
    return { text, spoken: `at ${text}` };
  }
  return null;
}

/**
 * A row's three columns: the margin, the speaker, the words. The speaker column is as narrow as
 * "Christy (AI)", so a turn keeps the width of the pane and stops wrapping to three or four lines.
 */
const ROW = 'grid grid-cols-[5.25rem_4.75rem_minmax(0,1fr)] border-b border-rule';
const MARGIN = 'flex flex-col items-start border-r border-rule-2 py-2 pl-4 pr-1 font-mono text-meta';
const WORDS = 'min-w-0 py-2.5 pl-1 pr-6';

/** Why a turn with a time has no audio, when the host has nothing more exact to say. */
const CANNOT_PLAY = 'This turn cannot start playback.';

/** The pane's own heading sticks above the rows, so a row is brought in below it. */
const PANE_HEAD_PX = 56;

/** Bring a row into its pane with no animation, and only when it is not already in view. */
function revealRow(row: HTMLElement, intoWindow: boolean): void {
  const pane = row.closest<HTMLElement>('[data-review-pane]');
  if (!pane) {
    row.scrollIntoView?.({ block: 'nearest' });
    return;
  }
  const paneBox = pane.getBoundingClientRect();
  const rowBox = row.getBoundingClientRect();
  if (rowBox.top < paneBox.top + PANE_HEAD_PX || rowBox.bottom > paneBox.bottom) {
    pane.scrollTop += rowBox.top - paneBox.top - PANE_HEAD_PX;
  }
  if (!intoWindow) return;
  const shown = row.getBoundingClientRect();
  if (shown.top < 0 || shown.bottom > window.innerHeight) row.scrollIntoView?.({ block: 'center' });
}

function TurnWords({ turn, text, evidence, activeEvidence }: {
  turn: TranscriptLine;
  text: string;
  evidence: readonly TurnEvidence[];
  activeEvidence: number | null;
}) {
  // Offsets are into the stored text. A presented turn can drop a stored prefix, and then no offset
  // can be trusted, so the words stay plain. Only a candidate turn is ever cited.
  const spans = evidence.length > 0 && text === turn.text ? markedSpans(text, evidence) : [{ text, numbers: [] }];
  return (
    <p
      className={cx(
        'whitespace-pre-wrap text-sm leading-[1.3125rem]',
        turn.speaker === 'bot' ? 'text-ink-secondary' : 'text-ink',
      )}
    >
      {spans.map((span, index) =>
        span.numbers.length === 0 ? (
          <Fragment key={index}>{span.text}</Fragment>
        ) : (
          <EvidenceMark
            key={index}
            numbers={span.numbers}
            active={activeEvidence !== null && span.numbers.includes(activeEvidence)}
          >
            {span.text}
          </EvidenceMark>
        ),
      )}
    </p>
  );
}

/** "Cited · Objection handling" once for each metric in the turn, with its numbers beside it. */
function Citations({ evidence, activeEvidence, onEvidence }: {
  evidence: readonly TurnEvidence[];
  activeEvidence: number | null;
  onEvidence?: (number: number) => void;
}) {
  const byMetric = new Map<string, TurnEvidence[]>();
  for (const quote of evidence) byMetric.set(quote.metricName, [...(byMetric.get(quote.metricName) ?? []), quote]);
  return (
    <ul className="mt-1 flex flex-wrap justify-end gap-x-4 gap-y-1">
      {[...byMetric].map(([metricName, quotes]) => (
        <li key={metricName} className="flex items-center gap-1.5 text-meta text-ink-tertiary">
          <span>Cited · {metricName}</span>
          {quotes.map(({ number, family }) => {
            const pressed = number === activeEvidence;
            return (
              <button
                key={number}
                type="button"
                onClick={() => onEvidence?.(number)}
                aria-pressed={pressed}
                aria-label={`Evidence ${number}, ${metricName}`}
                className={cx(
                  'min-h-6 min-w-6 rounded-evidence border px-1 font-mono text-meta transition-colors duration-hover ease-out',
                  evidenceNumberClass(family ?? null, pressed),
                  !pressed && 'hover:bg-field',
                )}
              >
                {number}
              </button>
            );
          })}
        </li>
      ))}
    </ul>
  );
}

/** The consent gate's mark: the same 1px diagonal hatch it has on the strip. */
function ConsentSwatch() {
  return (
    <svg aria-hidden="true" width="24" height="12" className="chart-paper block border border-ink-tertiary">
      <line x1="-3" y1="12" x2="9" y2="0" stroke="var(--ink-3)" />
      <line x1="3" y1="12" x2="15" y2="0" stroke="var(--ink-3)" />
      <line x1="9" y1="12" x2="21" y2="0" stroke="var(--ink-3)" />
      <line x1="15" y1="12" x2="27" y2="0" stroke="var(--ink-3)" />
    </svg>
  );
}

export function SeekableTranscript({
  transcript,
  activeTurnIndex,
  onSeek,
  recordingReady,
  isLoading = false,
  error = null,
  onRetry,
  className,
  approximateTiming = false,
  turnNumbers,
  turnTimes,
  unseekableReason = null,
  speakers,
  clock,
  evidence,
  activeEvidence = null,
  onEvidence,
  consent = null,
  announce = true,
  reveal,
}: SeekableTranscriptProps) {
  const numberOf = (index: number) => turnNumbers?.[index] ?? index + 1;
  const approx = approximateTiming ? '≈' : '';
  const activeRef = useRef<HTMLLIElement>(null);
  const [announcement, setAnnouncement] = useState('');

  const speakerOf = useCallback(
    (turn: TranscriptLine): string => {
      const presented = presentTranscriptTurn(turn.speaker, turn.text);
      if (!speakers || presented.plannedEvidence) return presented.label;
      return turn.speaker === 'bot' ? speakers.bot : speakers.candidate;
    },
    [speakers],
  );

  // In the commit, so a cue lands in the frame it was pressed in. Only a new request may touch the
  // window: playback moving the row on must not scroll the page.
  const revealSeen = useRef(reveal?.seq);
  useLayoutEffect(() => {
    const asked = reveal !== undefined && reveal.seq !== revealSeen.current;
    revealSeen.current = reveal?.seq;
    if (activeTurnIndex != null && activeRef.current) {
      revealRow(activeRef.current, asked && reveal.intoWindow);
    }
  }, [activeTurnIndex, reveal]);

  // Announce active turn change, and take it back when no turn is active: a row can light before its
  // media exists (a press), so a failed load must not leave "Now playing" behind.
  useEffect(() => {
    if (announce && activeTurnIndex != null && transcript[activeTurnIndex]) {
      const turn = transcript[activeTurnIndex];
      const number = turnNumbers?.[activeTurnIndex] ?? activeTurnIndex + 1;
      const speaker = speakerOf(turn);
      setAnnouncement(
        hasTiming(turn)
          ? `Now playing turn ${number}: ${speaker}`
          : `Turn ${number}: ${speaker}. ${unseekableReason ?? CANNOT_PLAY}`,
      );
    } else {
      setAnnouncement('');
    }
  }, [activeTurnIndex, transcript, turnNumbers, announce, speakerOf, unseekableReason]);

  const anyTimed = useMemo(() => transcript.some(hasTiming), [transcript]);
  const anyUntimed = useMemo(
    () => transcript.some((t, i) => !hasTiming(t) && !displayTime(turnTimes?.[i])),
    [transcript, turnTimes],
  );

  const consentRow = (fold: ConsentFold, active: boolean) => (
    <li
      key="consent"
      ref={active ? activeRef : undefined}
      data-consent-line=""
      className={cx(ROW, active && 'bg-field')}
    >
      <div className={MARGIN}>
        <span className="py-1 text-ink-secondary">
          {fold.atSec === null ? '' : `${fold.approximate ? '≈' : ''}${timecode(fold.atSec)}`}
        </span>
        <span className="text-ink-tertiary">{fold.turnsLabel}</span>
      </div>
      <div className="pl-2 pt-3">
        <ConsentSwatch />
      </div>
      <p className={cx(WORDS, 'text-label text-ink-secondary')}>
        <span className="font-medium text-ink">{fold.line}</span>{' '}
        <button type="button" onClick={fold.onShow} className="textlink text-label text-ink">
          {fold.showLabel}
        </button>
      </p>
    </li>
  );

  const turnRow = (turn: TranscriptLine, index: number) => {
    const timed = hasTiming(turn);
    const active = activeTurnIndex === index;
    const presented = presentTranscriptTurn(turn.speaker, turn.text);
    const speaker = speakerOf(turn);
    const printedSec = clock?.[index] ?? turn.start_offset_sec ?? null;
    const printed = printedSec === null ? null : timecode(printedSec);
    const cited = evidence?.get(index) ?? [];
    const shown = timed ? null : displayTime(printedSec === null ? turnTimes?.[index] : { sec: printedSec });

    return (
      <li
        key={index}
        ref={active ? activeRef : undefined}
        data-turn-row={numberOf(index)}
        data-turn-active={active ? '' : undefined}
        // With no timecode button this is what opening the consent line hands focus to.
        tabIndex={timed ? undefined : -1}
        className={cx(ROW, active && 'bg-field')}
      >
        <div
          className={MARGIN}
          role={timed ? undefined : 'group'}
          aria-label={
            timed
              ? undefined
              : shown
                ? `Turn ${numberOf(index)}: ${speaker}. ${approximateTiming ? 'About ' : ''}${shown.spoken}. ${unseekableReason ?? CANNOT_PLAY}`
                : `Turn ${numberOf(index)}: ${speaker}. Timing data not available.`
          }
        >
          {timed ? (
            <button
              type="button"
              onClick={() => onSeek(turn.start_offset_sec!, index)}
              aria-current={active ? 'true' : undefined}
              aria-label={`Turn ${numberOf(index)}: ${speaker}. At ${approximateTiming ? 'about ' : ''}${printed}. Click to play from here.`}
              className={cx(
                '-ml-1.5 inline-flex min-h-6 items-center gap-1 rounded-evidence px-1.5 py-1 transition-colors duration-hover ease-out',
                active ? 'font-medium text-ink' : 'text-ink-secondary hover:text-ink hover:underline',
              )}
            >
              {active && (
                <span
                  aria-hidden="true"
                  data-active-turn-marker=""
                  className="h-2 w-1.5 shrink-0 bg-ink [clip-path:polygon(0_0,100%_50%,0_100%)]"
                />
              )}
              {approx}
              {printed}
            </button>
          ) : shown ? (
            <span data-turn-time="not-seekable" className="py-1 text-ink-secondary">
              {approx}
              {shown.text}
            </span>
          ) : (
            <span className="py-1 font-sans italic leading-4 text-ink-secondary">no timing data</span>
          )}
          <span className="text-ink-tertiary">T{numberOf(index)}</span>
        </div>
        <div className="min-w-0 pl-2 pr-1 pt-2.5">
          <span
            className={cx(
              'block break-words text-meta leading-[1.125rem]',
              turn.speaker === 'bot' ? 'text-ink-tertiary' : 'font-semibold text-voice',
            )}
          >
            {speaker}
          </span>
        </div>
        <div className={WORDS}>
          <TurnWords turn={turn} text={presented.text} evidence={cited} activeEvidence={activeEvidence} />
          {cited.length > 0 && <Citations evidence={cited} activeEvidence={activeEvidence} onEvidence={onEvidence} />}
        </div>
      </li>
    );
  };

  let body: ReactNode;

  if (isLoading) {
    body = (
      <div role="status" aria-label="Loading transcript" className="px-6 py-4">
        <SkeletonText lines={8} gap={18} />
        <span className="sr-only">Loading transcript…</span>
      </div>
    );
  } else if (error) {
    body = (
      <div role="alert" className="mx-6 my-4 rounded-control border border-[var(--c-negative)] bg-[var(--c-negative-light)] p-3">
        <p className="text-sm text-[var(--c-ink-secondary)]">{error}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 inline-flex min-h-[44px] items-center rounded-control border border-[var(--c-control-border)] bg-[var(--c-surface)] px-3 py-1.5 text-xs font-medium text-[var(--c-ink)] transition-colors hover:bg-[var(--c-border-light)]"
          >
            Try again
          </button>
        )}
      </div>
    );
  } else if (transcript.length === 0) {
    body = (
      <p className="mx-6 my-4 rounded-control border border-dashed border-[var(--c-border)] px-4 py-8 text-center text-sm text-[var(--c-ink-secondary)]">
        No transcript lines recorded for this session yet.
      </p>
    );
  } else {
    const folded = (index: number) => consent !== null && index >= consent.firstIndex && index <= consent.lastIndex;
    const activeFolded = activeTurnIndex !== null && folded(activeTurnIndex);
    body = (
      <div>
        {!recordingReady && anyTimed && (
          <p className="mx-6 my-2 rounded-control bg-[var(--c-border-light)] px-3 py-2 text-xs text-[var(--c-ink-secondary)]">
            Click any timed transcript turn to automatically load the recording and jump to that moment.
          </p>
        )}
        {anyUntimed && anyTimed && (
          <p className="mx-6 my-2 rounded-control bg-[var(--c-border-light)] px-3 py-2 text-xs text-[var(--c-ink-secondary)]">
            Some turns were saved without timing, so they cannot start playback. They are shown without a timestamp.
          </p>
        )}
        <ol role="list">
          {transcript.map((turn, index) => {
            if (!folded(index)) return turnRow(turn, index);
            return index === consent!.firstIndex ? consentRow(consent!, activeFolded) : null;
          })}
        </ol>
      </div>
    );
  }

  // A plain wrapper, not a landmark: the workspace wraps this in the single
  // bounded `role="region" aria-label="Transcript"` scroll container, and two
  // regions with the same name would be a duplicate-landmark violation.
  return (
    <div className={className}>
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {body}
    </div>
  );
}
