/**
 * SeekableTranscript — clickable turn-level transcript with active highlight.
 *
 * - Timed turns (start_offset_sec != null) are ALWAYS rendered as real
 *   <button> elements, even before the recording is loaded. Clicking a
 *   timed turn calls onSeek(offsetSec) — the parent workspace handles
 *   minting the URL and queuing the seek if needed.
 * - Untimed turns (start_offset_sec == null) are rendered non-interactive
 *   with a clear "no timing data" label.
 * - The active turn receives aria-current="true", a left border accent,
 *   and a screen-reader announcement via aria-live.
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
}: SeekableTranscriptProps) {
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
      setAnnouncement(`Now playing turn ${activeTurnIndex + 1}: ${presented.label}`);
    }
  }, [activeTurnIndex, transcript]);

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
            Some turns lack timing data and cannot be used for playback — they are shown below without a timestamp.
          </p>
        )}
        <ul className="space-y-1" role="list">
          {transcript.map((turn, index) => {
            const timed = hasTiming(turn);
            const active = activeTurnIndex === index;
            const presented = presentTranscriptTurn(turn.speaker, turn.text);
            const speaker = presented.label;
            // Speaker is legible without colour: the label is always written
            // out. The tint only makes the alternation scannable. The bot
            // tint is the page ground and the candidate tint the card fill,
            // which are DIFFERENT tokens from the accent tint the active turn
            // takes — so an active bot turn is never the same fill as an
            // inactive one, and the 2px accent rule reads as a change of
            // state rather than a change of speaker.
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
                    aria-label={`Turn ${index + 1}: ${speaker}. At ${formatOffset(turn.start_offset_sec!)}. Click to play from here.`}
                    className={cx(
                      'w-full min-h-[44px] rounded-md px-3 py-2.5 text-left transition-colors',
                      'focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)] focus:ring-inset',
                      active
                        ? 'border-l-2 border-[var(--c-accent)] bg-[var(--c-accent-light)]'
                        : cx('border-l-2 border-transparent', speakerTint, 'hover:bg-[var(--c-accent-light)]'),
                    )}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="text-xs font-medium text-[var(--c-ink-secondary)]">
                        {speaker}
                      </span>
                      <span className="text-xs tabular-nums text-[var(--c-ink-secondary)]">
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
                  className={cx(
                    'min-h-[44px] rounded-md border-l-2 border-transparent px-3 py-2.5',
                    speakerTint,
                  )}
                  aria-label={`Turn ${index + 1}: ${speaker}. Timing data not available.`}
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
