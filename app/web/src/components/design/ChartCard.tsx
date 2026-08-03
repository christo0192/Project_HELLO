import type { ReactNode } from 'react';
import { cx } from './cx';

export interface ChartCardProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Prevents layout jump while the body is loading/chartless. */
  minHeight?: number;
}

/** Card container for chart/KPI blocks with a consistent header row. */
export function ChartCard({
  title,
  description,
  actions,
  children,
  className,
  minHeight = 260,
}: ChartCardProps) {
  return (
    <section
      aria-label={title}
      className={cx('rounded-xl border border-line bg-surface p-5 shadow-card', className)}
    >
      <header className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {description && (
            <p className="mt-0.5 text-xs text-ink-tertiary">{description}</p>
          )}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      <div style={{ minHeight }}>{children}</div>
    </section>
  );
}
