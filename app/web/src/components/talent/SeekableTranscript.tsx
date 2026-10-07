/**
 * SeekableTranscript — clickable turn-level transcript with active highlight.
 *
 * - Timed turns (start_offset_sec != null) are ALWAYS rendered as real
 *   <button> elements, even before the recording is loaded. Clicking a
 *   timed turn calls onSeek(offsetSec) — the parent workspace handles
 *   minting the URL and queuing the seek if needed.
 * - Untimed turns (start_offset_sec == null) are rendered non-interactive
 *   with a clear "no timing data" label.
 * - The active turn receives aria-current="true", a stronger tint with a
 *   leading accent dot, and a screen-reader announcement via aria-live.
 * - Keyboard: Tab moves between buttons; Enter/Space activates seek.
 * - Respects prefers-reduced-motion for scroll-into-view.
 */

import { useEffect, useRef, useState, useMemo } from 'react';
import type { TranscriptLine } from '../../types';
import { cx } from '../design/cx';
import { SkeletonText } from '../design/Skeleton';
import { presentTranscriptTurn } from '../../lib/transcript-presentation';

export interface SeekableTranscriptProps {
  transcript: TranscriptLine[];
  activeTurnIndex: number | null;
  onSeek: (offsetSec: number) => void;
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
}

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function formatOffset(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function hasTiming(t: TranscriptLine): boolean {
  return t.start_offset_sec != null;
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
}: SeekableTranscriptProps) {
  const numberOf = (index: number) => turnNumbers?.[index] ?? index + 1;
  const approx = approximateTiming ? '≈' : '';
  const activeRef = useRef<HTMLButtonElement>(null);
  const [announcement, setAnnouncement] = useState('');

  // Scroll active turn into view (guard scrollIntoView — absent in jsdom and
  // some embedded webviews).
  useEffect(() => {
    const el = activeRef.current;
    if (activeTurnIndex != null && el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({
        block: 'nearest',
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      });
    }
  }, [activeTurnIndex]);

  // Announce active turn change
  useEffect(() => {
    if (activeTurnIndex != null && transcript[activeTurnIndex]) {
      const t = transcript[activeTurnIndex];
      const presented = presentTranscriptTurn(t.speaker, t.text);
      setAnnouncement(`Now playing turn ${turnNumbers?.[activeTurnIndex] ?? activeTurnIndex + 1}: ${presented.label}`);
    }
  }, [activeTurnIndex, transcript, turnNumbers]);

  const anyTimed = useMemo(() => transcript.some(hasTiming), [transcript]);
  const anyUntimed = useMemo(() => transcript.some((t) => !hasTiming(t)), [transcript]);

  let body: React.ReactNode;

  if (isLoading) {
    body = (
      <div role="status" aria-label="Loading transcript">
        <SkeletonText lines={4} gap={12} />
        <span className="sr-only">Loading transcript…</span>
      </div>
    );
  } else if (error) {
    body = (
      <div role="alert" className="rounded-lg border border-[var(--c-negative)] bg-[var(--c-negative-light)] p-3">
        <p className="text-sm text-[var(--c-ink-secondary)]">{error}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 inline-flex min-h-[44px] items-center rounded-lg border border-[var(--c-control-border)] bg-[var(--c-surface)] px-3 py-1.5 text-xs font-medium text-[var(--c-ink)] transition-colors hover:bg-[var(--c-border-light)]"
          >
            Try again
          </button>
        )}
      </div>
    );
  } else if (transcript.length === 0) {
    body = (
      <p className="rounded-lg border border-dashed border-[var(--c-border)] px-4 py-8 text-center text-sm text-[var(--c-ink-secondary)]">
        No transcript lines recorded for this session yet.
      </p>
    );
  } else {
    body = (
      <div>
        {!recordingReady && anyTimed && (
          <p className="mb-3 rounded-md bg-[var(--c-border-light)] px-3 py-2 text-xs text-[var(--c-ink-secondary)]">
            Click any timed transcript turn to automatically load the recording and jump to that moment.
          </p>
        )}
        {anyUntimed && anyTimed && (
          <p className="mb-3 rounded-md bg-[var(--c-border-light)] px-3 py-2 text-xs text-[var(--c-ink-secondary)]">
            Some turns were saved without timing, so they cannot start playback. They are shown without a timestamp.
          </p>
        )}
        <ul className="space-y-1" role="list">
          {transcript.map((turn, index) => {
            const timed = hasTiming(turn);
            const active = activeTurnIndex === index;
            const presented = presentTranscriptTurn(turn.speaker, turn.text);
            const speaker = presented.label;
            // Speaker is legible without colour: the label is always written
            // out. The tint only makes the alternation scannable: the bot
            // tint is the page ground, the candidate tint the card fill.
            //
            // THE ACTIVE TURN is marked by a stronger tint (the hairline
            // token, a step darker than the hover tint) PLUS a leading
            // "playing" dot and an accent timestamp, so it never depends on a
            // one-step fill difference alone. It used to carry a 2px accent
            // rule down its left edge: a side-stripe, which the design system
            // bans outright.
            const speakerTint =
              turn.speaker === 'bot'
                ? 'bg-[var(--c-bg)]'
                : 'bg-[var(--c-surface)]';

            if (timed) {
              return (
                <li key={index}>
                  <button
                    type="button"
                    ref={active ? activeRef : undefined}
                    onClick={() => onSeek(turn.start_offset_sec!)}
                    aria-current={active ? 'true' : undefined}
                    aria-label={`Turn ${numberOf(index)}: ${speaker}. At ${approximateTiming ? 'about ' : ''}${formatOffset(turn.start_offset_sec!)}. Click to play from here.`}
                    className={cx(
                      'w-full min-h-[44px] rounded-md px-3 py-2.5 text-left transition-colors duration-150 ease-out',
                      'focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)] focus:ring-inset',
                      active
                        ? 'bg-[var(--c-border)]'
                        : cx(speakerTint, 'hover:bg-[var(--c-border-light)]'),
                    )}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-xs font-medium text-[var(--c-ink-secondary)]">
                        {active && (
                          <span
                            aria-hidden="true"
                            data-active-turn-marker=""
                            className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--c-accent)]"
                          />
                        )}
                        {speaker}
                      </span>
                      <span
                        className={cx(
                          'text-xs tabular-nums',
                          // Ink, not the accent: accent on the active tint
                          // is ~4:1, short of AA for 12px text.
                          active
                            ? 'font-semibold text-[var(--c-ink)]'
                            : 'text-[var(--c-ink-secondary)]',
                        )}
                      >
                        {approx}
                        {formatOffset(turn.start_offset_sec!)}
                      </span>
                    </span>
                    <span className="mt-0.5 block whitespace-pre-wrap text-sm leading-relaxed text-[var(--c-ink)]">
                      {presented.text}
                    </span>
                  </button>
                </li>
              );
            }

            return (
              <li key={index}>
                <div
                  className={cx('min-h-[44px] rounded-md px-3 py-2.5', speakerTint)}
                  aria-label={`Turn ${numberOf(index)}: ${speaker}. Timing data not available.`}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-xs font-medium text-[var(--c-ink-secondary)]">
                      {speaker}
                    </span>
                    <span className="text-xs italic text-[var(--c-ink-secondary)]">
                      no timing data
                    </span>
                  </span>
                  <span className="mt-0.5 block whitespace-pre-wrap text-sm leading-relaxed text-[var(--c-ink)]">
                    {presented.text}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
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
