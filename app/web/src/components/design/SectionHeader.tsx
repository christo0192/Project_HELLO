/**
 * SectionHeader — the one heading row used inside panels and above
 * tables: title (h2/h3), one-sentence description, optional actions.
 *
 * Type: the title sits on the SECTION step of the scale (15/20, 600,
 * -0.01em) at both levels. `level` is document outline, not size: an h2 on
 * the ground and an h3 inside a panel read at the same weight, and the page
 * title (28/34) is the only step above them. The description is the label
 * step (13/20) in tertiary ink; `meta` (a count, a badge) sits on the title's
 * baseline in tabular figures so "24" and "240" do not jitter as data loads.
 *
 * Sentence case, no eyebrows, no uppercase tracking.
 */
import type { ReactNode } from 'react';
import { cx } from './cx';

export interface SectionHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Heading level — h2 for page sections, h3 inside a panel. */
  level?: 2 | 3;
  /** Small count or status shown next to the title. */
  meta?: ReactNode;
  id?: string;
  className?: string;
}

export function SectionHeader({
  title,
  description,
  actions,
  level = 2,
  meta,
  id,
  className,
}: SectionHeaderProps) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <div
      className={cx(
        'flex flex-wrap items-start justify-between gap-x-4 gap-y-2',
        className,
      )}
    >
      <div className="min-w-0">
        {/* Baseline, not centre: a count or a badge beside the title lines up
            with the title's letters rather than floating at its mid-height. */}
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <Heading id={id} className="text-section text-ink">
            {title}
          </Heading>
          {meta != null && meta !== false && (
            <span className="text-label tabular-nums text-ink-tertiary">{meta}</span>
          )}
        </div>
        {description && (
          <p className="mt-0.5 max-w-2xl text-pretty text-label text-ink-tertiary">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
