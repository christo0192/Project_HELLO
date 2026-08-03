/**
 * Read-only transcript list with truthful loading / empty / error states.
 *
 * The API returns transcript turns as `{ speaker: 'bot' | 'candidate', text }`
 * — there are NO timestamps in the contract, so none are fabricated here.
 * Each turn is rendered with an explicit speaker label for AT users.
 */

import type { TranscriptLine } from '../../types';
import { SkeletonText } from '../design/Skeleton';
import { cx } from '../design/cx';

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
      <ul className="space-y-3">
        {transcript.map((line, index) => {
          const isBot = line.speaker === 'bot';
          return (
            <li
              key={index}
              className={cx('flex flex-col', isBot ? 'items-start' : 'items-end')}
            >
              <span className="mb-0.5 px-1 text-[11px] font-medium uppercase tracking-wide text-ink-tertiary">
                {isBot ? 'Bot' : 'Candidate'}
              </span>
              <div
                className={cx(
                  'max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed sm:max-w-[75%]',
                  isBot
                    ? 'rounded-tl-sm bg-surface-tertiary text-ink'
                    : 'rounded-tr-sm bg-brand-600 text-white',
                )}
              >
                {line.text}
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
