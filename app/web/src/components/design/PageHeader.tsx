import type { ReactNode } from 'react';
import { cx } from './cx';

export interface PageHeaderProps {
  title: string;
  description?: string;
  /** Small uppercase label above the title (e.g. section name). */
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
        'flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between',
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow && (
          <p className="text-xs font-semibold uppercase tracking-wide text-brand-600 dark:text-brand-400">
            {eyebrow}
          </p>
        )}
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-ink sm:text-2xl">
          {title}
        </h1>
        {description && (
          <p className="mt-1 max-w-2xl text-sm text-ink-secondary">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
