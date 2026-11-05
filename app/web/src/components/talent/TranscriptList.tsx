/**
 * Read-only transcript list with truthful loading / empty / error states.
 *
 * The API returns transcript turns as `{ speaker: 'bot' | 'candidate', text }`
 * — there are NO timestamps in the contract, so none are fabricated here.
 * Each turn is rendered with an explicit speaker label for AT users.
 *
 * The same form as Review: rows on a log sheet, the speaker in a printed column
 * and the words beside it. Not chat bubbles: this is the record of a call.
 */

import type { TranscriptLine } from '../../types';
import { SkeletonText } from '../design/Skeleton';
import { cx } from '../design/cx';
import { presentTranscriptTurn } from '../../lib/transcript-presentation';

export interface TranscriptListProps {
  transcript: TranscriptLine[];
  isLoading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  className?: string;
}

export function TranscriptList({
  transcript,
  isLoading = false,
  error = null,
  onRetry,
  className,
}: TranscriptListProps) {
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
        <p className="text-sm text-error-text">{error}</p>
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
      <ul className="divide-y divide-glass-ring">
        {transcript.map((line, index) => {
          const isBot = line.speaker === 'bot';
          const presented = presentTranscriptTurn(line.speaker, line.text);
          return (
            <li key={index} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 py-2.5">
              {/* Speaker label in sentence case at the meta step: the words identify
                  the speaker, and the candidate's label takes the voice ink. */}
              <span
                className={cx(
                  'pt-0.5 text-xs',
                  isBot ? 'font-medium text-ink-tertiary' : 'font-semibold text-voice',
                )}
              >
                {presented.label}
                {line.is_gate === true ? ' · consent' : ''}
              </span>
              {/* The candidate's words are carbon ink, the interviewer's graphite. */}
              <div className={cx('whitespace-pre-wrap text-sm leading-relaxed', isBot ? 'text-ink-secondary' : 'text-ink')}>
                {presented.text}
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <section aria-label="Transcript" className={className}>
      {body}
    </section>
  );
}
