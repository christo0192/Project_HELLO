/**
 * The right panel of Recording: the transcript as a log sheet.
 *
 * The timecode is the seek button and the words are plain text, so a reader can select and copy them.
 * Timecode and turn number sit in the margin; the turn number is the one the scorecard cites.
 *
 * The active row is a shaded printed field, a ▶ glyph and a heavier timecode, so it never depends on
 * one step of fill alone. Highlighter wash means cited words and nothing else; a search match is not
 * washed, it only narrows the list.
 *
 * Follow. The active row is kept in view without animation, by moving this panel's own scroll
 * position, so the page behind it never jumps. A reader who takes over stops it, and "Back to current"
 * gives it back. That is a wheel, a touch or a scroll key, a press that is not on a button (selecting
 * text must not be pulled away), or a `scroll` to anywhere but where this panel put itself: a scrollbar
 * drag sends nothing else, and moving the panel here fires `scroll` too.
 * A hidden panel has no layout to move, so it catches up when it is shown (`visible`): a quote on
 * Overview can light a row before its tab has opened.
 */
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent, ReactNode } from 'react';
import { Button, SegmentedControl, TextField, cx } from '../design';
import { clockText } from '../../lib/r1-recording';
import { highlightRanges, phaseLabel } from '../../lib/r1-review';
import type { PlacedTurn } from '../../lib/r1-review';

type Filter = 'all' | 'candidate';

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: 'all', label: 'All turns' },
  { value: 'candidate', label: 'Candidate only' },
];

const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);

function Words({ text, quotes }: { text: string; quotes: readonly string[] }) {
  const ranges = highlightRanges(text, quotes);
  if (ranges.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark key={start} className="rounded-evidence bg-wash text-ink">
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

interface RowProps {
  turn: PlacedTurn;
  active: boolean;
  onSeek: (row: number) => void;
}

const Row = memo(function Row({ turn, active, onSeek }: RowProps) {
  const metrics = [...new Set(turn.citations.map((citation) => citation.metric))];
  const time = turn.startSec ?? turn.callSec;
  return (
    <li
      data-turn-row={turn.row}
      aria-current={active ? 'true' : undefined}
      className={cx('grid grid-cols-[3.75rem_minmax(0,1fr)] gap-x-3 px-4 py-2.5', active && 'bg-surface-secondary')}
    >
      <div className="font-mono text-meta leading-5">
        {turn.startSec !== null ? (
          <button
            type="button"
            onClick={() => onSeek(turn.row)}
            aria-label={`Play from ${clockText(turn.startSec)}, turn ${turn.turn_index}`}
            className={cx(
              'block rounded-evidence hover:underline focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ink)]',
              active ? 'font-semibold text-ink' : 'text-ink-secondary',
            )}
          >
            {active && <span aria-hidden="true">▶ </span>}
            {clockText(turn.startSec)}
          </button>
        ) : time !== null ? (
          <span className="block text-ink-secondary">{clockText(time)}</span>
        ) : (
          <span className="block font-sans text-ink-tertiary">No time</span>
        )}
        <span className="block text-ink-tertiary">T{turn.turn_index}</span>
      </div>
      <div className="min-w-0">
        <p className="flex flex-wrap items-baseline justify-between gap-x-2 text-meta leading-5">
          <span className={turn.speakerKind === 'candidate' ? 'font-semibold text-voice' : 'text-ink-secondary'}>
            {turn.speakerLabel}
          </span>
          {metrics.length > 0 && <span className="font-medium text-ink-secondary">Cited · {metrics.join(', ')}</span>}
        </p>
        <p className={cx('whitespace-pre-wrap text-sm leading-[1.3125rem]', turn.speakerKind === 'candidate' ? 'text-ink' : 'text-ink-secondary')}>
          <Words text={turn.text} quotes={turn.citations.map((citation) => citation.quote)} />
        </p>
        {turn.interrupted && <p className="text-meta leading-5 text-ink-tertiary">Cut off</p>}
      </div>
    </li>
  );
});

export interface ReviewTranscriptProps {
  turns: readonly PlacedTurn[];
  activeRow: number | null;
  onSeek: (row: number) => void;
  /** False while the tab hiding this panel is closed. */
  visible: boolean;
  /** What an attempt with no turns says. Without it: none were saved. */
  emptyText?: string;
  className?: string;
}

export function ReviewTranscript({ turns, activeRow, onSeek, visible, emptyText, className }: ReviewTranscriptProps) {
  const headingId = useId();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [following, setFollowing] = useState(true);
  const [announcement, setAnnouncement] = useState('');
  const scrollerRef = useRef<HTMLDivElement>(null);
  /** Where this panel last put itself, or settled after a change of rows. */
  const placedTopRef = useRef(0);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return turns.filter(
      (turn) =>
        (filter === 'all' || turn.speakerKind === 'candidate') && (!needle || turn.text.toLowerCase().includes(needle)),
    );
  }, [turns, filter, query]);

  const bringIntoView = (row: number | null) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const element = row === null ? null : scroller.querySelector<HTMLElement>(`[data-turn-row="${row}"]`);
    if (element) {
      const top = element.offsetTop;
      const bottom = top + element.offsetHeight;
      if (top < scroller.scrollTop || bottom > scroller.scrollTop + scroller.clientHeight) {
        scroller.scrollTop = Math.max(0, top - scroller.clientHeight / 3);
      }
    }
    placedTopRef.current = scroller.scrollTop;
  };

  useLayoutEffect(() => {
    if (following && visible) bringIntoView(activeRow);
  }, [activeRow, following, shown, visible]);

  useEffect(() => {
    const turn = activeRow === null ? null : turns[activeRow];
    setAnnouncement(turn ? `Now playing turn ${turn.turn_index}: ${turn.speakerLabel}` : '');
  }, [activeRow, turns]);

  // Playing a row is coming back to the recording: following resumes from there.
  const seek = useCallback(
    (row: number) => {
      setFollowing(true);
      onSeek(row);
    },
    [onSeek],
  );

  const narrowed = shown.length !== turns.length;
  const stopFollowing = () => setFollowing(false);
  const onScroll = () => {
    const scroller = scrollerRef.current;
    if (scroller && Math.abs(scroller.scrollTop - placedTopRef.current) > 1) stopFollowing();
  };
  // A timecode takes the reader back to the recording, so pressing one must not flash "Back to current".
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!(event.target as HTMLElement).closest('button')) stopFollowing();
  };
  let phaseShown: string | null = null;

  return (
    <section aria-labelledby={headingId} className={cx('flex min-h-0 flex-col', className)}>
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {/* The tab above says what this is, so the name is only for assistive technology. */}
      <h2 id={headingId} className="sr-only">
        Transcript
      </h2>
      <div className="space-y-2 border-b border-line px-4 pb-3">
        <p className="text-meta tabular-nums text-ink-tertiary">
          {narrowed ? `${shown.length} of ${turns.length} turns` : `${turns.length} turns`}
        </p>
        <div className="flex items-center gap-2">
          <TextField
            type="search"
            size="sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            aria-label="Search the transcript"
            className="min-w-0 flex-1"
          />
          <SegmentedControl options={FILTERS} value={filter} onChange={setFilter} ariaLabel="Whose turns" size="sm" />
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollerRef}
          role="region"
          aria-label="Transcript turns"
          tabIndex={0}
          onWheel={stopFollowing}
          onTouchMove={stopFollowing}
          onScroll={onScroll}
          onPointerDown={onPointerDown}
          onKeyDown={(event) => {
            if (SCROLL_KEYS.has(event.key)) stopFollowing();
          }}
          className="absolute inset-0 overflow-y-auto overscroll-contain focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--ink)]"
        >
          {shown.length === 0 ? (
            <p className="px-4 py-6 text-sm text-ink-secondary">
              {turns.length === 0 ? (emptyText ?? 'No transcript lines were saved for this attempt.') : 'No turn matches.'}
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {shown.flatMap((turn) => {
                const phase = phaseLabel(turn.phase);
                const divider = phase && phase !== phaseShown;
                if (phase) phaseShown = phase;
                return [
                  ...(divider
                    ? [
                        <li key={`phase-${turn.row}`} data-phase-divider="" className="bg-surface-secondary px-4 py-1 form-label">
                          {phase}
                        </li>,
                      ]
                    : []),
                  <Row key={turn.row} turn={turn} active={turn.row === activeRow} onSeek={seek} />,
                ];
              })}
            </ul>
          )}
        </div>
        {!following && activeRow !== null && (
          <div className="absolute bottom-3 left-0 right-0 flex justify-center">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setFollowing(true);
                bringIntoView(activeRow);
              }}
            >
              Back to current
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
