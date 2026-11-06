/**
 * ReviewCallStrip: the call drawn to scale, the one thing on Review that only HELLO has.
 *
 * 24px tall. The candidate's turns stand full height in the voice mark, the interviewer's a third of
 * that in `--ai`, the consent gate is hatched, a line drop runs on a dotted baseline, and every
 * evidence quote is one numbered tick, its box in the family of the rating it cites, so the strip shows
 * where the weak and the strong evidence sit. Its stem stays ink, to read across the voice mark. Any
 * other gap between calls stays bare paper. Candidate and interviewer are told apart by height and by
 * the transcript's speaker labels, not by colour.
 *
 * This is the phone strip. The R1 review page draws its call with `CallStrip.tsx` beside this file,
 * from speakers, phases and moments; a later change can bring the two onto one. Nothing here knows
 * where the numbers came from. `callStripGeometry.ts` holds the arithmetic and its tests.
 *
 * The ticks are real buttons. The picture itself is one `role="img"` with the whole strip in words.
 * Moving the playhead is not animated: a cue is instant.
 */

import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cx } from '../design/cx';
import { evidenceNumberClass, type JudgementFamily } from '../design/tones';
import { dropStartSec, layoutTickLabels, stripAxis, stripBreaks, timecode } from './callStripGeometry';
import type { StripDrop, StripSegment } from './callStripGeometry';

const STRIP_HEIGHT = 24;
const AI_HEIGHT = 8;
/** A tick's numbered box, and the room it takes on the row above the strip. */
const TICK_BOX = 22;
const FALLBACK_WIDTH = 1000;
const NO_GAPS: readonly StripDrop[] = [];

export interface ReviewCallStripTick {
  number: number;
  sec: number;
  /** The tick's accessible name: "Evidence 3: turn 12 at 02:20, Objection handling". */
  label: string;
  /** The family of the rating it cites. A metric with no score has none, and stays ink. */
  family?: JudgementFamily | null;
}

/** Words printed above the strip at a moment: the consent span, the line drop. */
export interface ReviewCallStripNote {
  sec: number;
  text: string;
}

export interface ReviewCallStripProps {
  segments: readonly StripSegment[];
  endSec: number;
  drops?: readonly StripDrop[];
  /** Gaps before a later call that no drop explains: bare paper, cut like a drop only when too long. */
  gaps?: readonly StripDrop[];
  ticks?: readonly ReviewCallStripTick[];
  notes?: readonly ReviewCallStripNote[];
  /** Where the playhead sits; null draws none. */
  positionSec?: number | null;
  /** The tick that is cued. */
  activeTick?: number | null;
  onTick?: (number: number) => void;
  /** The whole strip in words: length, share, consent time, drops and quote count. */
  alternative: string;
  className?: string;
}

export function ReviewCallStrip({
  segments,
  endSec,
  drops = NO_GAPS,
  gaps = NO_GAPS,
  ticks = [],
  notes = [],
  positionSec = null,
  activeTick = null,
  onTick,
  alternative,
  className,
}: ReviewCallStripProps) {
  const hatchId = `hatch-${useId().replace(/:/g, '')}`;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);

  // Boxes are laid out in px, so they follow the strip's own width. A layout effect, or the first
  // paint would draw them for the wrong width and jump.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      if (root.clientWidth > 0) setWidth(root.clientWidth);
    };
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const axis = useMemo(
    () => stripAxis(endSec, stripBreaks([...drops, ...gaps], segments)),
    [endSec, drops, gaps, segments],
  );
  const { percent } = axis;
  const ordered = useMemo(() => [...ticks].sort((a, b) => a.sec - b.sec || a.number - b.number), [ticks]);
  const labels = useMemo(
    () => layoutTickLabels(ordered.map((tick) => (percent(tick.sec) / 100) * width), width, TICK_BOX),
    [ordered, percent, width],
  );

  return (
    <div ref={rootRef} data-call-strip="" className={cx('relative', className)}>
      {/* The row above the strip: words at a moment, then the numbered boxes. */}
      <div className="relative h-[1.375rem]">
        {notes.map((note) => (
          <span
            key={`${note.sec}-${note.text}`}
            className="absolute top-0.5 whitespace-nowrap text-meta text-ink-tertiary"
            style={{ left: `${percent(note.sec)}%` }}
          >
            {note.text}
          </span>
        ))}
        {ordered.map((tick, index) => {
          const pressed = tick.number === activeTick;
          return (
            <button
              key={tick.number}
              type="button"
              data-strip-tick={tick.number}
              onClick={() => onTick?.(tick.number)}
              aria-pressed={pressed}
              aria-label={tick.label}
              className={cx(
                'absolute top-0 flex h-[1.125rem] min-w-[1.125rem] -translate-x-1/2 items-center justify-center rounded-evidence border px-0.5 font-mono text-meta leading-none transition-colors duration-hover ease-out',
                evidenceNumberClass(tick.family ?? null, pressed),
                !pressed && 'hover:bg-field',
              )}
              style={{ left: `${labels[index]}px` }}
            >
              {tick.number}
            </button>
          );
        })}
      </div>

      <div className="chart-paper relative h-6">
        <svg role="img" aria-label={alternative} className="block h-6 w-full overflow-visible">
          <defs>
            <pattern id={hatchId} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="4" height="4" fill="var(--paper)" />
              <line x1="0" y1="0" x2="0" y2="4" stroke="var(--ink-3)" strokeWidth="1" />
            </pattern>
          </defs>
          {segments.map((segment) => {
            const start = percent(segment.startSec);
            const span = Math.max(percent(segment.endSec) - start, 0.1);
            const thin = segment.kind === 'ai';
            return (
              <rect
                key={`${segment.kind}-${segment.startSec}`}
                data-strip-segment={segment.kind}
                x={`${start}%`}
                y={thin ? (STRIP_HEIGHT - AI_HEIGHT) / 2 : 0}
                width={`${span}%`}
                height={thin ? AI_HEIGHT : STRIP_HEIGHT}
                fill={
                  segment.kind === 'candidate'
                    ? 'var(--voice-mark)'
                    : segment.kind === 'ai'
                      ? 'var(--ai)'
                      : `url(#${hatchId})`
                }
              />
            );
          })}
          {drops.map((drop) => (
            <line
              key={drop.toSec}
              data-strip-drop=""
              x1={`${percent(dropStartSec(drop, segments))}%`}
              x2={`${percent(drop.toSec)}%`}
              y1={STRIP_HEIGHT / 2}
              y2={STRIP_HEIGHT / 2}
              stroke="var(--ink-3)"
              strokeWidth="1.5"
              strokeDasharray="1.5 3"
              strokeLinecap="round"
            />
          ))}
        </svg>
        {/* A gap too long to draw to scale: the baseline is cut, and the alternative gives its length. */}
        {axis.breakCentres.map((centre) => (
          <span
            key={centre}
            aria-hidden="true"
            data-strip-break=""
            className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 bg-paper px-0.5 font-mono text-meta leading-none text-ink-secondary"
            style={{ left: `${centre}%` }}
          >
            {'//'}
          </span>
        ))}
        {ordered.map((tick) => (
          <span
            key={tick.number}
            aria-hidden="true"
            className="pointer-events-none absolute -top-1 bottom-0 w-px bg-ink"
            style={{ left: `${percent(tick.sec)}%` }}
          />
        ))}
        {positionSec !== null && (
          <span
            aria-hidden="true"
            data-playhead=""
            className="pointer-events-none absolute -bottom-1 -top-1 w-0.5 -translate-x-px bg-ink"
            style={{ left: `${percent(positionSec)}%` }}
          />
        )}
      </div>

      <div aria-hidden="true" className="relative mt-1.5 h-4 font-mono text-meta text-ink-tertiary">
        {axis.marks.map((sec, index) => (
          <span
            key={sec}
            className={cx('absolute top-0', index > 0 && '-translate-x-1/2')}
            style={{ left: `${percent(sec)}%` }}
          >
            {timecode(sec)}
          </span>
        ))}
      </div>
    </div>
  );
}

export interface ReviewCallStripLegendProps {
  candidateName: string;
  /** "≈4:47 · ≈75% of talk". */
  candidateTalk?: string | null;
  aiName: string;
  /** "≈1:35". */
  aiTalk?: string | null;
  className?: string;
}

/** What each mark means. The strip's text alternative says the same, so this is hidden from AT. */
export function ReviewCallStripLegend({ candidateName, candidateTalk, aiName, aiTalk, className }: ReviewCallStripLegendProps) {
  return (
    <ul aria-hidden="true" className={cx('flex flex-wrap items-center gap-x-4 gap-y-1 text-meta text-ink-secondary', className)}>
      <li className="flex items-center gap-1.5 whitespace-nowrap">
        <svg width="14" height="12" className="chart-paper block">
          <rect width="14" height="12" fill="var(--voice-mark)" />
        </svg>
        <span className="font-medium text-ink">{candidateName}</span>
        {candidateTalk}
      </li>
      <li className="flex items-center gap-1.5 whitespace-nowrap">
        <svg width="14" height="12" className="chart-paper block">
          <rect y="4" width="14" height="4" fill="var(--ai)" />
        </svg>
        {aiName}
        {aiTalk ? ` ${aiTalk}` : ''}
      </li>
      <li className="flex items-center gap-1.5 whitespace-nowrap">
        <svg width="14" height="12" className="chart-paper block">
          {[-3, 1, 5, 9, 13].map((x) => (
            <line key={x} x1={x} y1="12" x2={x + 12} y2="0" stroke="var(--ink-3)" />
          ))}
        </svg>
        Consent
      </li>
      <li className="flex items-center gap-1.5 whitespace-nowrap">
        <span className="flex h-3.5 w-3.5 items-center justify-center rounded-evidence border border-ink font-mono text-meta leading-none text-ink">
          1
        </span>
        Evidence quote
      </li>
    </ul>
  );
}
