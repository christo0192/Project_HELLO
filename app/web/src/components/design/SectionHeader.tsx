/**
 * SectionHeader — the one heading row used inside panels and above
 * tables: title (h2/h3), one-sentence description, optional actions.
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
        <div className="flex flex-wrap items-center gap-2">
          <Heading
            id={id}
            className="text-[15px] font-semibold tracking-[-0.01em] text-ink"
          >
            {title}
          </Heading>
          {meta}
        </div>
        {description && (
          <p className="mt-0.5 max-w-2xl text-[13px] leading-5 text-ink-tertiary">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
