import type { ReactNode } from 'react';
import { cx } from './cx';

export interface PageHeaderProps {
  title: string;
  description?: string;
  /** Small context label above the title (e.g. area name). Sentence case. */
  eyebrow?: string;
  actions?: ReactNode;
  className?: string;
}

/**
 * Page heading block: eyebrow, title, description and action slot.
 *
 * The description is shown IN FULL. It wraps at a reading measure (~70ch)
 * instead of being cut to one line: a sentence truncated mid-word ("…through
 * screen…") says less than no sentence at all, and the page header is the one
 * place a page gets to say what it is for. Keep the copy to one or two short
 * sentences at the call site rather than clamping it here.
 *
 * Type follows the shared scale: title 28/34 semibold with tight tracking,
 * description at body size (14/20) in secondary ink, eyebrow as a quiet
 * sentence-case label, never uppercase.
 */
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <div
      className={cx(
        'flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between sm:gap-6',
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        {eyebrow && (
          <p className="text-label font-medium text-ink-tertiary">{eyebrow}</p>
        )}
        <h1 className="mt-0.5 text-title text-ink">
          {title}
        </h1>
        {description && (
          <p className="mt-1.5 max-w-[70ch] text-pretty text-sm leading-5 text-ink-secondary">
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
