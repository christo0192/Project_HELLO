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
      const speaker = t.speaker === 'bot' ? 'Bot' : 'Candidate';
      setAnnouncement(`Now playing turn ${activeTurnIndex + 1}: ${speaker}`);
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
      <div role="alert" className="rounded-lg border border-error/30 bg-error-soft p-3">
        <p className="text-sm text-error">{error}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 inline-flex items-center rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-surface-tertiary"
          >
            Try again
          </button>
        )}
      </div>
    );
  } else if (transcript.length === 0) {
    body = (
      <p className="rounded-lg border border-dashed border-line-strong bg-surface-secondary px-4 py-8 text-center text-sm text-ink-secondary">
        No transcript lines recorded for this session yet.
      </p>
    );
  } else {
    body = (
      <div>
        {!recordingReady && anyTimed && (
          <p className="mb-3 rounded-md bg-surface-secondary px-3 py-2 text-xs text-ink-secondary">
            Click any timed transcript turn to automatically load the recording and jump to that moment.
          </p>
        )}
        {anyUntimed && anyTimed && (
          <p className="mb-3 rounded-md bg-surface-secondary px-3 py-2 text-xs text-ink-secondary">
            Some turns lack timing data and cannot be used for playback — they are shown below without a timestamp.
          </p>
        )}
        <ul className="space-y-0.5" role="list">
          {transcript.map((turn, index) => {
            const timed = hasTiming(turn);
            const active = activeTurnIndex === index;
            const speaker = turn.speaker === 'bot' ? 'Bot' : 'Candidate';

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
                      'w-full text-left px-3 py-3 rounded-md transition-colors min-h-[44px]',
                      'focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)] focus:ring-inset',
                      active
                        ? 'bg-[var(--c-accent-light)] border-l-2 border-[var(--c-accent)]'
                        : 'bg-transparent border-l-2 border-transparent hover:bg-surface-secondary',
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-medium uppercase tracking-wide text-ink-tertiary">
                        {speaker}
                      </span>
                      <span className="text-[11px] tabular-nums text-ink-tertiary">
                        {formatOffset(turn.start_offset_sec!)}
                      </span>
                    </span>
                    <span className="mt-0.5 block whitespace-pre-wrap text-sm leading-relaxed text-ink">
                      {turn.text}
                    </span>
                  </button>
                </li>
              );
            }

            return (
              <li key={index}>
                <div
                  className="px-3 py-3 rounded-md opacity-80 border-l-2 border-transparent min-h-[44px]"
                  aria-label={`Turn ${index + 1}: ${speaker}. Timing data not available.`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-ink-tertiary">
                      {speaker}
                    </span>
                    <span className="text-[11px] italic text-ink-tertiary">
                      no timing data
                    </span>
                  </span>
                  <span className="mt-0.5 block whitespace-pre-wrap text-sm leading-relaxed text-ink">
                    {turn.text}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  return (
    <section aria-label="Transcript" className={className}>
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {body}
    </section>
  );
}
