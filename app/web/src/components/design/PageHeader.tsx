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

/** Page heading block: eyebrow, title, description and action slot. */
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
        'flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between',
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow && (
          <p className="text-[13px] font-medium text-ink-tertiary">{eyebrow}</p>
        )}
        <h1 className="mt-0.5 text-title text-ink">{title}</h1>
        {description && (
          <p className="mt-1.5 max-w-2xl text-sm leading-6 text-ink-secondary">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
